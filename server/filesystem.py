"""Platform adapters for guarded directory-relative filesystem operations."""

from __future__ import annotations

import os
from pathlib import Path
import stat

NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
NONBLOCK = getattr(os, "O_NONBLOCK", 0)
WINDOWS = os.name == "nt"

if WINDOWS:
    import msvcrt
    from . import windows
else:
    import fcntl


def open_directory(path, create=False):
    if WINDOWS:
        return windows.WindowsDirectory(path, create)
    if not NOFOLLOW or os.open not in os.supports_dir_fd:
        raise RuntimeError("Secure storage needs directory-relative operations and O_NOFOLLOW")
    path = Path(os.path.abspath(os.fspath(path)))
    descriptor = os.open(path.anchor, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW)
    try:
        for component in path.parts[1:]:
            if create:
                try:
                    os.mkdir(component, mode=0o700, dir_fd=descriptor)
                except FileExistsError:
                    pass
            next_descriptor = os.open(component, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = next_descriptor
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def close_directory(directory):
    directory.close() if WINDOWS else os.close(directory)


def duplicate_directory(directory):
    return open_directory(directory.path) if WINDOWS else os.dup(directory)


def subdirectory(directory, name):
    return open_directory(directory.path / name) if WINDOWS else os.open(name, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW, dir_fd=directory)


def open_file(directory, name, flags, mode=0o600):
    return directory.open(name, flags, mode) if WINDOWS else os.open(name, flags | NOFOLLOW, mode, dir_fd=directory)


def private_directory(directory):
    if WINDOWS:
        windows.check_private_handle(directory.handles[-1])
    else:
        info = os.fstat(directory)
        if info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise PermissionError("Data directory must be owned by the current user with mode 0700")


def private_file(descriptor):
    info = os.fstat(descriptor)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise PermissionError("Storage contains an unsafe file")
    if WINDOWS:
        windows.check_private_handle(msvcrt.get_osfhandle(descriptor))
    elif info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise PermissionError("Storage contains a file with unsafe ownership or permissions")


def list_directory(directory):
    return os.listdir(directory.path if WINDOWS else directory)


def stat_file(directory, name):
    return os.stat(directory.path / name, follow_symlinks=False) if WINDOWS else os.stat(name, dir_fd=directory, follow_symlinks=False)


def unlink_file(directory, name):
    if WINDOWS:
        os.unlink(directory.path / name)
    else:
        os.unlink(name, dir_fd=directory)


def replace_file(directory, source, target):
    if WINDOWS:
        windows.replace(directory, source, target)
    else:
        os.replace(source, target, src_dir_fd=directory, dst_dir_fd=directory)


def sync_directory(directory):
    if not WINDOWS:
        os.fsync(directory)
    # Windows replacement uses MOVEFILE_WRITE_THROUGH; directory fsync is absent.


def lock_file(descriptor):
    windows.lock(descriptor) if WINDOWS else fcntl.flock(descriptor, fcntl.LOCK_EX)


def unlock_file(descriptor):
    windows.unlock(descriptor) if WINDOWS else fcntl.flock(descriptor, fcntl.LOCK_UN)
