# OrcaSlicer headless slicing sidecar.
#
# Reuses the linuxserver/orcaslicer image (has orca-slicer CLI + bundled
# printer/process/filament profiles baked in under /opt/orcaslicer/resources)
# but replaces the s6/Selkies GUI entrypoint with a Waitress WSGI server
# that drives the CLI directly. No Xvfb/X11/GUI needed for CLI slicing.
#
# Waitress (not Flask's built-in werkzeug server) so health checks and
# overlapping slice requests do not trip connection resets under Node's
# undici keep-alive pool during long blocking CLI runs.
FROM lscr.io/linuxserver/orcaslicer:v2.4.2-ls35

RUN /lsiopy/bin/pip3 install --no-cache-dir flask==3.1.3 waitress==3.0.2

COPY sidecar.py /opt/sidecar/sidecar.py

ENV SLICER_KIND=orca \
    SLICER_BIN=/opt/orcaslicer/bin/orca-slicer \
    SIDECAR_WORKDIR=/tmp/sidecar-jobs \
    PORT=2814 \
    WAITRESS_THREADS=8

EXPOSE 2814

ENTRYPOINT ["/lsiopy/bin/python3", "/opt/sidecar/sidecar.py"]
