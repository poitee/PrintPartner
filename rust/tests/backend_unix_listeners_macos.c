#include <errno.h>
#include <libproc.h>
#include <limits.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>
#include <sys/socket.h>
#include <sys/un.h>

static void fail(const char *message) {
    fprintf(stderr, "%s: %s\n", message, strerror(errno));
    exit(1);
}

int main(int argc, char **argv) {
    if (argc != 2) return 1;
    char *end;
    long parsed = strtol(argv[1], &end, 10);
    if (*end || parsed <= 0 || parsed > INT32_MAX) return 1;
    int pid = (int)parsed;
    int capacity = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, NULL, 0);
    if (capacity <= 0) fail("cannot size backend fd table");
    struct proc_fdinfo *fds = NULL;
    int size;
    for (int attempt = 0;; attempt++) {
        if (attempt == 8 || capacity > INT_MAX - (int)(32 * sizeof(*fds))) {
            errno = EOVERFLOW;
            fail("backend fd table keeps growing");
        }
        capacity += 32 * sizeof(*fds);
        free(fds);
        fds = malloc((size_t)capacity);
        if (!fds) fail("cannot allocate backend fd table");
        size = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, fds, capacity);
        if (size <= 0 || size % sizeof(*fds)) fail("cannot read backend fd table");
        if (size < capacity) break;
    }
    printf("unix-listeners-v1 %d\n", pid);
    for (size_t i = 0; i < (size_t)size / sizeof(*fds); i++) {
        if (fds[i].proc_fdtype != PROX_FDTYPE_SOCKET) continue;
        struct socket_fdinfo info;
        int count = proc_pidfdinfo(pid, fds[i].proc_fd, PROC_PIDFDSOCKETINFO, &info, sizeof(info));
        if (count <= 0 && errno == EBADF) continue;
        if (count != (int)sizeof(info)) fail("cannot inspect backend socket");
        if (info.psi.soi_family != AF_UNIX || !(info.psi.soi_options & SO_ACCEPTCONN)) continue;
        if (info.psi.soi_kind != SOCKINFO_UN || !info.psi.soi_so) fail("invalid Unix socket identity");
        const struct sockaddr_un *address = &info.psi.soi_proto.pri_un.unsi_addr.ua_sun;
        size_t prefix = offsetof(struct sockaddr_un, sun_path);
        size_t length = 0;
        if (address->sun_family == AF_UNIX) {
            if (address->sun_len < prefix || address->sun_len > sizeof(*address)) fail("invalid Unix address length");
            length = address->sun_len - prefix;
            length = strnlen(address->sun_path, length);
        } else if (address->sun_family != AF_UNSPEC) {
            fail("invalid Unix address family");
        }
        printf("%llx\t", (unsigned long long)info.psi.soi_so);
        for (size_t j = 0; j < length; j++) printf("%02x", (unsigned char)address->sun_path[j]);
        putchar('\n');
    }
    free(fds);
    puts("end");
    return 0;
}
