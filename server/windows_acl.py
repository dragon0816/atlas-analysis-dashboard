"""Pure SID policy shared by the Windows ACL reader and platform-neutral tests."""

SYSTEM = "S-1-5-18"
ADMINISTRATORS = "S-1-5-32-544"
OWNER_RIGHTS = "S-1-3-4"


def private_principals(owner_sid: str, user_sid: str) -> frozenset[str]:
    """Allow owner-relative rights only after the actual owner is trusted."""
    if not user_sid or owner_sid not in (user_sid, ADMINISTRATORS):
        raise PermissionError("Private storage has an untrusted Windows owner")
    # OWNER RIGHTS refers to this object's verified owner, not a broad group.
    # CPython mkdir(mode=0o700) uses this SID in its protected directory ACL.
    return frozenset((user_sid, SYSTEM, ADMINISTRATORS, OWNER_RIGHTS))
