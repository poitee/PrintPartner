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
cleanup assertion. The later runs below supplied the evidence for changing the
trap's forced-detach target.

Hosted [diagnostic run 39185522717](https://github.com/poitee/PrintPartner/actions/runs/39185522717/job/117847314975)
passed the suite and eight repetitions, then failed repetition 9 while ejecting
the backing disk. The Python holder had exited. The exact image remained attached,
with its DiskImages helper holding the sparseimage file. That helper normally
backs the image; its presence does not establish the cause of the busy eject.
Failure diagnostics now include privileged open-file inspection, device state and
DiskArbitration messages restricted to the owned image's device identifiers.
Verbose forced-detach output preserves the original exit status and assertions.

Hosted [run 39186091368](https://github.com/poitee/PrintPartner/actions/runs/39186091368/job/117848988156)
failed repetition 8 the same way. DiskArbitration logged the forced unmount of
`disk8s1` as successful, then the eject of backing `disk7` failed with EBUSY
19 ms later. The holder had exited and only the DiskImages helper held the image.
After that partial success the mount path is an ordinary directory, so the trap
had no safe target to retry. The trap now records the whole-disk device printed
by `hdiutil attach` and retries `hdiutil detach -force` on it up to three times,
two seconds apart. This is the retry pattern tools such as create-dmg use for
`hdiutil detach` EBUSY. The warning still fires if every forced attempt fails.
The native test also requires that `hdiutil info` no longer lists the image.
The diagnostic driver now releases the holder after any completed `lsof` attempt,
not only a successful one.
