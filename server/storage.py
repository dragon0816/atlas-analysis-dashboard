"""Private, atomic dashboard persistence with process-safe optimistic locking."""

from __future__ import annotations

from contextlib import contextmanager
import hashlib
import os
from pathlib import Path
import re
import stat
import threading
import unicodedata
import uuid

from .schema import MAX_BYTES, decode_document, encode_document
from .filesystem import (NONBLOCK, WINDOWS, close_directory, list_directory, lock_file,
                         open_directory, open_file, private_directory, private_file,
                         replace_file, stat_file, sync_directory, unlink_file, unlock_file)


class StoreError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def default_data_dir() -> Path:
    override = os.environ.get("ATLAS_DASHBOARD_DATA_DIR")
    if override:
        return Path(override).expanduser().absolute()
    if WINDOWS:
        local = os.environ.get("LOCALAPPDATA")
        base = Path(local) if local else Path.home() / "AppData" / "Local"
        return base / "AtlasAnalysisDashboard" / "dashboards"
    base = os.environ.get("XDG_DATA_HOME")
    if base and not Path(base).is_absolute():
        base = None
    return (Path(base) if base else Path.home() / ".local" / "share") / "atlas-analysis-dashboard" / "dashboards"


def validate_name(name: str) -> str:
    try:
        size = len(name.encode("utf-8")) if isinstance(name, str) else 0
    except UnicodeError as error:
        raise StoreError(400, "Dashboard name must be valid Unicode") from error
    if not isinstance(name, str) or not name or size > 180:
        raise StoreError(400, "Dashboard name must contain 1–180 UTF-8 bytes")
    if name != name.strip() or name.startswith(".") or name.endswith("."):
        raise StoreError(400, "Dashboard name has unsafe leading or trailing characters")
    if any(character in '/\\:%?*<>|"' or unicodedata.category(character).startswith("C") for character in name):
        raise StoreError(400, "Dashboard name contains unsupported characters")
    if unicodedata.normalize("NFC", name) != name:
        raise StoreError(400, "Dashboard name must use normalized Unicode")
    if re.fullmatch(r"(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?", name, re.IGNORECASE):
        raise StoreError(400, "Dashboard name is reserved")
    return name


def _regular_private_file(descriptor):
    try:
        private_file(descriptor)
    except PermissionError as error:
        raise StoreError(403, "Dashboard storage contains an unsafe file or permissions") from error


def revision(payload: bytes) -> str:
    return '"' + hashlib.sha256(payload).hexdigest() + '"'


class DashboardStore:
    def __init__(self, directory: Path | str | None = None):
        self.directory = Path(directory) if directory is not None else default_data_dir()
        self._directory_fd = open_directory(self.directory, create=True)
        self._lock_fd = None
        self._thread_lock = threading.RLock()
        try:
            try:
                private_directory(self._directory_fd)
            except PermissionError as error:
                raise StoreError(403, "Data directory must have private ownership and permissions") from error
            self._lock_fd = open_file(self._directory_fd, ".lock", os.O_RDWR | os.O_CREAT | NONBLOCK, 0o600)
            _regular_private_file(self._lock_fd)
        except BaseException:
            self.close()
            raise

    def close(self):
        if self._lock_fd is not None:
            os.close(self._lock_fd)
            self._lock_fd = None
        if self._directory_fd is not None:
            close_directory(self._directory_fd)
            self._directory_fd = None

    @contextmanager
    def _locked(self):
        with self._thread_lock:
            lock_file(self._lock_fd)
            try:
                held = os.fstat(self._lock_fd)
                live = stat_file(self._directory_fd, ".lock")
                if not stat.S_ISREG(live.st_mode) or (held.st_dev, held.st_ino) != (live.st_dev, live.st_ino):
                    raise StoreError(403, "Storage lock changed; restart the service")
                yield
            finally:
                unlock_file(self._lock_fd)

    def _read(self, name):
        try:
            descriptor = open_file(self._directory_fd, name + ".json", os.O_RDONLY | NONBLOCK)
        except FileNotFoundError:
            return None
        except OSError as error:
            raise StoreError(403, "Dashboard file cannot be accessed safely") from error
        try:
            _regular_private_file(descriptor)
            with os.fdopen(descriptor, "rb", closefd=False) as stream:
                payload = stream.read(MAX_BYTES + 1)
            if len(payload) > MAX_BYTES:
                raise StoreError(413, "Stored dashboard exceeds 2 MB")
            decode_document(payload)
            return payload
        finally:
            os.close(descriptor)

    def names(self):
        with self._locked():
            result = []
            for filename in list_directory(self._directory_fd):
                if not filename.endswith(".json"):
                    continue
                name = filename[:-5]
                try:
                    validate_name(name)
                    descriptor = open_file(self._directory_fd, filename, os.O_RDONLY | NONBLOCK)
                    try:
                        _regular_private_file(descriptor)
                        result.append(name)
                    finally:
                        os.close(descriptor)
                except (StoreError, OSError):
                    continue
            return sorted(result, key=lambda name: (name.casefold(), name))

    def get(self, name):
        validate_name(name)
        with self._locked():
            payload = self._read(name)
            if payload is None:
                raise StoreError(404, "Dashboard was not found")
            return payload, revision(payload)

    @staticmethod
    def _precondition(current, if_match, if_none_match):
        if if_match is not None and if_none_match is not None:
            raise StoreError(400, "Use exactly one write precondition")
        if if_none_match is not None:
            if if_none_match != "*":
                raise StoreError(400, "Creation requires If-None-Match: *")
            if current is not None:
                raise StoreError(412, "Dashboard already exists; choose another name")
        elif if_match is not None:
            if current is None or if_match != revision(current):
                raise StoreError(412, "Dashboard changed; reload it before saving")
        else:
            raise StoreError(428, "Creation requires If-None-Match; updates require If-Match")

    def put(self, name, document, *, if_match=None, if_none_match=None):
        validate_name(name)
        payload = encode_document(document)
        with self._locked():
            current = self._read(name)
            self._precondition(current, if_match, if_none_match)
            temporary = ".pending-" + uuid.uuid4().hex
            descriptor = open_file(self._directory_fd, temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                with os.fdopen(descriptor, "wb") as stream:
                    _regular_private_file(stream.fileno())
                    stream.write(payload)
                    stream.flush()
                    os.fsync(stream.fileno())
                replace_file(self._directory_fd, temporary, name + ".json")
                sync_directory(self._directory_fd)
            finally:
                try:
                    unlink_file(self._directory_fd, temporary)
                except FileNotFoundError:
                    pass
            return revision(payload), current is None

    def delete(self, name, *, if_match=None):
        validate_name(name)
        if not if_match:
            raise StoreError(428, "Deletion requires the current If-Match revision")
        with self._locked():
            current = self._read(name)
            if current is None or if_match != revision(current):
                raise StoreError(412, "Dashboard changed or was removed; reload before deleting")
            unlink_file(self._directory_fd, name + ".json")
            sync_directory(self._directory_fd)
