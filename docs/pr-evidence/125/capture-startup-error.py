import os
from pathlib import Path
import subprocess
import time
import gi
gi.require_version('Gdk','3.0')
from gi.repository import Gdk
root = Path(__file__).resolve().parent
manager = subprocess.Popen(['openbox'])
errors = root/'normal-startup-error.stderr.log'
with errors.open('w') as err:
    app = subprocess.Popen([str(Path.cwd()/'rust/target/debug/pp-desktop'),
        '--dev-stage',str(root/'private-resource-path-bootstrap-secret'),
        '--data',str(root/'error-data')],stderr=err,stdout=subprocess.DEVNULL,
        env=dict(os.environ,WEBKIT_DISABLE_COMPOSITING_MODE='1',LIBGL_ALWAYS_SOFTWARE='1'))
    try:
        for _ in range(100):
            if 'desktop_startup_failed:' in errors.read_text():
                break
            time.sleep(.1)
        assert 'resource_verification -> resources_unavailable -> os_error=2' in errors.read_text()
        assert 'private-resource-path-bootstrap-secret' not in errors.read_text()
        windows = []
        for _ in range(150):
            result = subprocess.run(['xdotool','search','--name','Print Partner could not start'],text=True,capture_output=True)
            windows = result.stdout.split()
            if windows:
                break
            assert app.poll() is None, 'App exited before showing the error dialog'
            time.sleep(.1)
        assert windows
        window = Gdk.get_default_root_window()
        Gdk.pixbuf_get_from_window(window,0,0,window.get_width(),window.get_height()).savev(
            str(root/'native-startup-error.png'),'png',[],[])
        subprocess.run(['xdotool','windowactivate','--sync',windows[-1],'key','Return'],check=True)
        assert app.wait(timeout=10) == 1
        print('PASS: normal native startup logged a redacted cause, showed the dialog and exited 1 after dismissal')
    finally:
        if app.poll() is None:
            app.terminate()
            app.wait(timeout=10)
        manager.terminate()
