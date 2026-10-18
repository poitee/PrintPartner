# Native image holder lifetime

Main run [39145106276](https://github.com/poitee/PrintPartner/actions/runs/39145106276/job/117734684460)
recorded the disposable Python holder with real `lsof`, then failed its forced
detach with `Resource busy`. The test kept the file open for 120 seconds, until
cleanup after the assertions, while requiring detach to succeed without warnings.
Earlier green runs do not establish that macOS can always eject an image while
that artificial holder remains open.

The fixture now holds its file through the normal detach retries and the real
`lsof` listing. After `lsof` succeeds, its wrapper requests release and waits for
the child to acknowledge that the file has closed before forwarding the forced
detach to real `hdiutil`. Both waits have deadlines. Failure cleanup still kills
the disposable holder and detaches any remaining mount.

The native assertions still require the holder PID and exact file path before
force, the unchanged command trace, exit status 23, no cleanup warnings, and an
unmounted image. A portable executable test uses an advisory file lock to prove
the child holds the file during the diagnostic and releases it before the detach
command. The macOS gate runs the full suite and ten additional native repetitions.

This fixes the fixture's lifetime contract. It does not establish the cause of
every DiskImages busy response. Accepting a warning would weaken the successful
cleanup assertion; changing production retry counts or disk targets would expand
the change without evidence. The workflow's cleanup trap stays unchanged.
