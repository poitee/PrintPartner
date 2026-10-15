#include <errno.h>
#include <stddef.h>
#include <stdio.h>

#ifdef __APPLE__
#include <sys/attr.h>
#include <sys/event.h>
#include <sys/mount.h>
#include <sys/stdio.h>
#include <unistd.h>

static void json_string(const char *value)
{
    putchar('"');
    for (const unsigned char *p = (const unsigned char *)value; *p; ++p) {
        if (*p == '"' || *p == '\\') {
            putchar('\\');
            putchar(*p);
        } else if (*p < 0x20) {
            printf("\\u%04x", (unsigned int)*p);
        } else {
            putchar(*p);
        }
    }
    putchar('"');
}

#define CONSTANT(name) printf("\"" #name "\":%lu,", (unsigned long)(name))

int main(int argc, char **argv)
{
    if (argc != 2) {
        fputs("usage: native-sdk existing-root\n", stderr);
        return 64;
    }
    int (*attribute_call)(int, void *, void *, size_t, unsigned int) = fgetattrlist;
    int (*swap_call)(const char *, const char *, unsigned int) = renamex_np;
    (void)attribute_call;
    (void)swap_call;
    printf("{\"constants\":{\"EVFILT_VNODE\":%d,", EVFILT_VNODE);
    CONSTANT(EV_ADD);
    CONSTANT(EV_CLEAR);
    CONSTANT(EV_RECEIPT);
    CONSTANT(EV_ERROR);
    CONSTANT(EV_EOF);
    CONSTANT(NOTE_DELETE);
    CONSTANT(NOTE_RENAME);
    CONSTANT(NOTE_REVOKE);
    CONSTANT(NOTE_LINK);
    CONSTANT(NOTE_WRITE);
    CONSTANT(NOTE_ATTRIB);
    CONSTANT(NOTE_EXTEND);
    CONSTANT(ATTR_BIT_MAP_COUNT);
    CONSTANT(ATTR_CMN_RETURNED_ATTRS);
    CONSTANT(ATTR_DIR_LINKCOUNT);
    CONSTANT(FSOPT_PACK_INVAL_ATTRS);
    printf("\"RENAME_SWAP\":%u},", RENAME_SWAP);
    printf("\"abi\":{\"attrlist_size\":%zu,\"attrlist_offsets\":[%zu,%zu,%zu,%zu,%zu,%zu,%zu],"
           "\"attribute_set_size\":%zu,\"uint32_size\":%zu,\"uint_size\":%zu,\"size_t_size\":%zu},",
           sizeof(struct attrlist), offsetof(struct attrlist, bitmapcount),
           offsetof(struct attrlist, reserved), offsetof(struct attrlist, commonattr),
           offsetof(struct attrlist, volattr), offsetof(struct attrlist, dirattr),
           offsetof(struct attrlist, fileattr), offsetof(struct attrlist, forkattr),
           sizeof(attribute_set_t), sizeof(u_int32_t), sizeof(unsigned int), sizeof(size_t));
    struct statfs fs;
    errno = 0;
    int rc = statfs(argv[1], &fs);
    int error = errno;
    printf("\"statfs\":{\"rc\":%d,\"errno\":%d", rc, error);
    if (rc == 0) {
        printf(",\"filesystem_type\":");
        json_string(fs.f_fstypename);
        printf(",\"mounted_device\":");
        json_string(fs.f_mntfromname);
        printf(",\"mountpoint\":");
        json_string(fs.f_mntonname);
        printf(",\"flags\":%lu", (unsigned long)fs.f_flags);
    }
    puts("}}");
    return ferror(stdout) ? 74 : 0;
}
#else
int main(void)
{
    fputs("UNEXECUTED_NATIVE_REQUIRED\n", stderr);
    return 77;
}
#endif
