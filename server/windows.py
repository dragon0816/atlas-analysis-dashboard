"""Windows handle-based filesystem guards using only Python standard libraries.

This module is imported only on Windows. Directory handles deny delete sharing,
so verified ancestors cannot be renamed while operations use their paths.
"""

from __future__ import annotations

import ctypes
from ctypes import wintypes
import errno
import msvcrt
import os
from pathlib import Path
import sys
import time

from .windows_acl import private_principals

kernel = ctypes.WinDLL("kernel32", use_last_error=True)
security = ctypes.WinDLL("advapi32", use_last_error=True)
INVALID_HANDLE = ctypes.c_void_p(-1).value
REPARSE = 0x400
DIRECTORY = 0x10
READ = 0x80000000
WRITE = 0x40000000
READ_CONTROL = 0x20000
SHARE_READ_WRITE = 3
OPEN_EXISTING = 3
OPEN_ALWAYS = 4
CREATE_NEW = 1
OPEN_REPARSE_POINT = 0x00200000
BACKUP_SEMANTICS = 0x02000000

kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
kernel.CreateFileW.restype = wintypes.HANDLE
kernel.CloseHandle.argtypes = [wintypes.HANDLE]
kernel.CloseHandle.restype = wintypes.BOOL
kernel.GetCurrentProcess.restype = wintypes.HANDLE
kernel.LocalFree.argtypes = [ctypes.c_void_p]
kernel.LocalFree.restype = ctypes.c_void_p
kernel.MoveFileExW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD]
kernel.MoveFileExW.restype = wintypes.BOOL
security.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
security.OpenProcessToken.restype = wintypes.BOOL
security.GetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
security.GetTokenInformation.restype = wintypes.BOOL
security.ConvertSidToStringSidW.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]
security.ConvertSidToStringSidW.restype = wintypes.BOOL
security.GetSecurityInfo.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]
security.GetSecurityInfo.restype = wintypes.DWORD
security.GetAce.argtypes = [ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p)]
security.GetAce.restype = wintypes.BOOL


class FileInformation(ctypes.Structure):
    _fields_ = [
        ("attributes", wintypes.DWORD), ("creation", wintypes.FILETIME),
        ("access", wintypes.FILETIME), ("write", wintypes.FILETIME),
        ("volume", wintypes.DWORD), ("size_high", wintypes.DWORD),
        ("size_low", wintypes.DWORD), ("links", wintypes.DWORD),
        ("index_high", wintypes.DWORD), ("index_low", wintypes.DWORD),
    ]


class ACL(ctypes.Structure):
    _fields_ = [("revision", wintypes.BYTE), ("reserved", wintypes.BYTE),
                ("size", wintypes.WORD), ("count", wintypes.WORD), ("reserved2", wintypes.WORD)]


class ACEHeader(ctypes.Structure):
    _fields_ = [("type", wintypes.BYTE), ("flags", wintypes.BYTE), ("size", wintypes.WORD)]


kernel.GetFileInformationByHandle.argtypes = [wintypes.HANDLE, ctypes.POINTER(FileInformation)]
kernel.GetFileInformationByHandle.restype = wintypes.BOOL


def _error():
    return ctypes.WinError(ctypes.get_last_error())


def _info(handle):
    info = FileInformation()
    if not kernel.GetFileInformationByHandle(handle, ctypes.byref(info)):
        raise _error()
    if info.attributes & REPARSE:
        raise PermissionError("Reparse points, junctions, and symbolic links are not supported")
    return info


def _sid_text(sid):
    result = ctypes.c_void_p()
    if not security.ConvertSidToStringSidW(sid, ctypes.byref(result)):
        raise _error()
    try:
        return ctypes.wstring_at(result)
    finally:
        kernel.LocalFree(result)


def _user_sid():
    token = wintypes.HANDLE()
    if not security.OpenProcessToken(kernel.GetCurrentProcess(), 0x0008, ctypes.byref(token)):
        raise _error()
    try:
        length = wintypes.DWORD()
        security.GetTokenInformation(token, 1, None, 0, ctypes.byref(length))
        buffer = ctypes.create_string_buffer(length.value)
        if not security.GetTokenInformation(token, 1, buffer, length, ctypes.byref(length)):
            raise _error()
        sid = ctypes.cast(buffer, ctypes.POINTER(ctypes.c_void_p))[0]
        return _sid_text(sid)
    finally:
        kernel.CloseHandle(token)


def check_private_handle(handle):
    """Reject foreign ownership, null ACLs, and access granted to other users."""
    owner, dacl, descriptor = ctypes.c_void_p(), ctypes.c_void_p(), ctypes.c_void_p()
    result = security.GetSecurityInfo(handle, 1, 0x00000001 | 0x00000004, ctypes.byref(owner), None, ctypes.byref(dacl), None, ctypes.byref(descriptor))
    if result:
        raise ctypes.WinError(result)
    try:
        user = _user_sid()
        if not owner.value or not dacl.value:
            raise PermissionError("Private storage must be owned by the current Windows user with a restrictive ACL")
        permitted = private_principals(_sid_text(owner), user)
        acl = ctypes.cast(dacl, ctypes.POINTER(ACL)).contents
        for index in range(acl.count):
            ace = ctypes.c_void_p()
            if not security.GetAce(dacl, index, ctypes.byref(ace)):
                raise _error()
            header = ctypes.cast(ace, ctypes.POINTER(ACEHeader)).contents
            if header.flags & 0x08:  # Inherit-only entries do not apply to this object.
                continue
            if header.type == 1:  # A deny ACE cannot broaden access.
                continue
            if header.type != 0 or header.size < 12:
                raise PermissionError("Private storage uses an unsupported ACL entry")
            sid = ctypes.c_void_p(ace.value + 8)
            if _sid_text(sid) not in permitted:
                raise PermissionError("Private storage grants access to another Windows user or group")
    finally:
        kernel.LocalFree(descriptor)


class WindowsDirectory:
    def __init__(self, path, create=False):
        if sys.version_info < (3, 13):
            raise RuntimeError("Windows requires Python 3.13+ for private 0700 directory creation")
        self.path = Path(os.path.abspath(os.fspath(path)))
        if str(self.path).startswith("\\\\"):
            raise PermissionError("UNC and network storage paths are not supported")
        self.handles = []
        current = Path(self.path.anchor)
        try:
            for component in (None, *self.path.parts[1:]):
                if component is not None:
                    current /= component
                    if create:
                        try:
                            os.mkdir(current, 0o700)
                        except FileExistsError:
                            pass
                handle = kernel.CreateFileW(str(current), READ_CONTROL, SHARE_READ_WRITE, None, OPEN_EXISTING, OPEN_REPARSE_POINT | BACKUP_SEMANTICS, None)
                if handle == INVALID_HANDLE:
                    raise _error()
                self.handles.append(handle)
                if not _info(handle).attributes & DIRECTORY:
                    raise NotADirectoryError(str(current))
        except BaseException:
            self.close()
            raise

    def close(self):
        for handle in reversed(self.handles):
            kernel.CloseHandle(handle)
        self.handles.clear()

    def open(self, name, flags, mode=0o600):
        if Path(name).name != name or ":" in name:
            raise PermissionError("Only a single safe filename is allowed")
        writable = bool(flags & (os.O_RDWR | os.O_WRONLY))
        access = READ_CONTROL | (WRITE if writable else 0) | (READ if not flags & os.O_WRONLY else 0)
        creation = CREATE_NEW if flags & os.O_EXCL else OPEN_ALWAYS if flags & os.O_CREAT else OPEN_EXISTING
        share = SHARE_READ_WRITE if name == ".lock" else 1
        handle = kernel.CreateFileW(str(self.path / name), access, share, None, creation, OPEN_REPARSE_POINT, None)
        if handle == INVALID_HANDLE:
            raise _error()
        try:
            info = _info(handle)
            if info.attributes & DIRECTORY:
                raise IsADirectoryError(name)
            fd = msvcrt.open_osfhandle(handle, flags & (os.O_RDWR | os.O_WRONLY) | os.O_BINARY)
            handle = None
            return fd
        finally:
            if handle is not None:
                kernel.CloseHandle(handle)


def lock(fd):
    if os.fstat(fd).st_size == 0:
        os.lseek(fd, 0, os.SEEK_SET)
        os.write(fd, b"\0")
        os.fsync(fd)
    deadline = time.monotonic() + 30
    while True:
        os.lseek(fd, 0, os.SEEK_SET)
        try:
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            return
        except OSError as error:
            if error.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK) or time.monotonic() > deadline:
                raise
            time.sleep(0.025)


def unlock(fd):
    os.lseek(fd, 0, os.SEEK_SET)
    msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)


def replace(directory, source, target):
    if not kernel.MoveFileExW(str(directory.path / source), str(directory.path / target), 0x1 | 0x8):
        raise _error()
