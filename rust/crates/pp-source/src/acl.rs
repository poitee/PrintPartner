//! Extended ACL policy for pinned confinement-root components.
//!
//! macOS ACLs supplement BSD mode bits, so a `0755` directory can still let
//! another principal add, remove, or re-secure its entries. The policy is
//! deliberately stricter than the kernel's evaluation:
//!
//! - Any allow entry for a principal other than the effective user or root
//!   (uid 0) that carries a write-class right is unsafe. Groups, including
//!   the user's own groups and `everyone`, are always foreign principals, as
//!   are UUIDs that do not resolve to a local uid/gid.
//! - Deny entries never offset a grant, wherever they appear in the ACL, so
//!   entry ordering cannot change the result. Deny-only ACLs are safe.
//! - Inheritance flags are ignored: inherited, inheritable, and inherit-only
//!   grants are judged alike, because directories created below the root
//!   would receive them.
//! - Foreign write grants are rejected even on sticky ancestors that the BSD
//!   mode check tolerates, because ACL rights are not bounded by the sticky
//!   bit's owner rule.

#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

/// `<sys/acl.h>` `acl_perm_t` rights that let a principal change the
/// directory's entries, its own placement, or its security. Attribute writes
/// are included conservatively. Read-class rights are never recorded.
pub(crate) const UNSAFE_PERMS: [u32; 8] = [
    1 << 2,  // ACL_ADD_FILE
    1 << 5,  // ACL_ADD_SUBDIRECTORY
    1 << 4,  // ACL_DELETE
    1 << 6,  // ACL_DELETE_CHILD
    1 << 8,  // ACL_WRITE_ATTRIBUTES
    1 << 10, // ACL_WRITE_EXTATTRIBUTES
    1 << 12, // ACL_WRITE_SECURITY
    1 << 13, // ACL_CHANGE_OWNER
];

#[derive(Clone, Copy, Debug)]
pub(crate) enum Principal {
    User(u32),
    Group(u32),
    Unknown,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Entry {
    pub(crate) allow: bool,
    pub(crate) principal: Principal,
    /// Union of the entry's rights from [`UNSAFE_PERMS`].
    pub(crate) perms: u32,
}

pub(crate) fn entries_are_trusted(entries: &[Entry], uid: u32) -> bool {
    entries.iter().all(|entry| {
        !entry.allow
            || entry.perms == 0
            || matches!(entry.principal, Principal::User(id) if id == uid || id == 0)
    })
}

/// Reads the extended ACL of an already-open directory. Any handle works,
/// including `O_SEARCH`; the path is never consulted again.
#[cfg(target_os = "macos")]
pub(crate) fn read(fd: std::os::fd::BorrowedFd<'_>) -> std::io::Result<Vec<Entry>> {
    use std::{
        ffi::{c_int, c_void},
        io,
        os::fd::AsRawFd,
    };

    const ACL_TYPE_EXTENDED: c_int = 0x100;
    const ACL_FIRST_ENTRY: c_int = 0;
    const ACL_NEXT_ENTRY: c_int = -1;
    const ACL_EXTENDED_DENY: c_int = 2;
    const ID_TYPE_UID: c_int = 0;
    const ID_TYPE_GID: c_int = 1;

    #[link(name = "System")]
    unsafe extern "C" {
        fn acl_get_fd_np(fd: c_int, ty: c_int) -> *mut c_void;
        fn acl_get_entry(acl: *mut c_void, entry_id: c_int, entry: *mut *mut c_void) -> c_int;
        fn acl_get_tag_type(entry: *mut c_void, tag: *mut c_int) -> c_int;
        fn acl_get_qualifier(entry: *mut c_void) -> *mut c_void;
        fn acl_get_permset(entry: *mut c_void, permset: *mut *mut c_void) -> c_int;
        fn acl_get_perm_np(permset: *mut c_void, perm: c_int) -> c_int;
        fn acl_free(obj: *mut c_void) -> c_int;
        fn mbr_uuid_to_id(uuid: *const u8, id: *mut u32, id_type: *mut c_int) -> c_int;
    }

    struct Owned(*mut c_void);
    impl Drop for Owned {
        fn drop(&mut self) {
            // SAFETY: allocated by the ACL library and freed exactly once.
            unsafe { acl_free(self.0) };
        }
    }

    // SAFETY: `fd` is a live descriptor borrowed for the duration of the call.
    let acl = unsafe { acl_get_fd_np(fd.as_raw_fd(), ACL_TYPE_EXTENDED) };
    if acl.is_null() {
        let error = io::Error::last_os_error();
        // ENOENT is how the ACL library reports "no extended ACL".
        return match error.raw_os_error() {
            Some(libc::ENOENT) => Ok(Vec::new()),
            _ => Err(error),
        };
    }
    let acl = Owned(acl);
    let mut entries = Vec::new();
    let mut entry_id = ACL_FIRST_ENTRY;
    loop {
        let mut entry = std::ptr::null_mut();
        // SAFETY: `acl` is a valid ACL; `entry` borrows from it.
        if unsafe { acl_get_entry(acl.0, entry_id, &mut entry) } != 0 {
            let error = io::Error::last_os_error();
            // The ACL and entry id are valid, so EINVAL marks the end.
            return match error.raw_os_error() {
                Some(libc::EINVAL) => Ok(entries),
                _ => Err(error),
            };
        }
        entry_id = ACL_NEXT_ENTRY;

        let mut tag = 0;
        // SAFETY: `entry` is a valid entry of `acl`.
        if unsafe { acl_get_tag_type(entry, &mut tag) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let mut permset = std::ptr::null_mut();
        // SAFETY: as above; `permset` borrows from `entry`.
        if unsafe { acl_get_permset(entry, &mut permset) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let mut perms = 0;
        for perm in UNSAFE_PERMS {
            // SAFETY: `permset` is valid while `acl` is alive.
            match unsafe { acl_get_perm_np(permset, perm as c_int) } {
                0 => {}
                1 => perms |= perm,
                _ => return Err(io::Error::last_os_error()),
            }
        }
        // SAFETY: as above; the returned guid_t is freed by `Owned`.
        let qualifier = unsafe { acl_get_qualifier(entry) };
        if qualifier.is_null() {
            return Err(io::Error::last_os_error());
        }
        let qualifier = Owned(qualifier);
        let (mut id, mut id_type) = (0, -1);
        // SAFETY: `qualifier` points to a 16-byte guid_t.
        let principal = match unsafe { mbr_uuid_to_id(qualifier.0.cast(), &mut id, &mut id_type) } {
            0 if id_type == ID_TYPE_UID => Principal::User(id),
            0 if id_type == ID_TYPE_GID => Principal::Group(id),
            _ => Principal::Unknown,
        };
        entries.push(Entry {
            // Unknown tags are judged as grants.
            allow: tag != ACL_EXTENDED_DENY,
            principal,
            perms,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ADD_FILE: u32 = UNSAFE_PERMS[0];
    const DELETE_CHILD: u32 = UNSAFE_PERMS[3];
    const ALL: u32 = 0b11_0101_0111_0100;

    fn allow(principal: Principal, perms: u32) -> Entry {
        Entry {
            allow: true,
            principal,
            perms,
        }
    }
    fn deny(principal: Principal, perms: u32) -> Entry {
        Entry {
            allow: false,
            principal,
            perms,
        }
    }

    #[test]
    fn foreign_write_grants_are_rejected() {
        assert_eq!(UNSAFE_PERMS.iter().fold(0, |all, perm| all | perm), ALL);
        for perm in UNSAFE_PERMS {
            for principal in [
                Principal::User(1001),
                Principal::Group(20),
                Principal::Unknown,
            ] {
                assert!(!entries_are_trusted(&[allow(principal, perm)], 1000));
            }
        }
        // Groups are foreign even when their id equals the user's or root's.
        assert!(!entries_are_trusted(
            &[allow(Principal::Group(0), ADD_FILE)],
            1000
        ));
        assert!(!entries_are_trusted(
            &[allow(Principal::Group(1000), DELETE_CHILD)],
            1000
        ));
    }

    #[test]
    fn deny_entries_never_offset_grants() {
        let user = Principal::User(1001);
        for entries in [
            [deny(user, ADD_FILE), allow(user, ADD_FILE)],
            [allow(user, ADD_FILE), deny(user, ADD_FILE)],
        ] {
            assert!(!entries_are_trusted(&entries, 1000));
        }
    }

    #[test]
    fn deny_only_and_read_grants_are_accepted() {
        assert!(entries_are_trusted(&[], 1000));
        assert!(entries_are_trusted(
            &[
                deny(Principal::Group(12), ALL),
                deny(Principal::Unknown, ALL)
            ],
            1000
        ));
        // A read-only grant records no unsafe rights.
        assert!(entries_are_trusted(&[allow(Principal::Group(12), 0)], 1000));
    }

    #[test]
    fn grants_to_user_or_root_are_accepted() {
        assert!(entries_are_trusted(
            &[
                allow(Principal::User(1000), ALL),
                allow(Principal::User(0), ALL)
            ],
            1000
        ));
    }
}
