import os, subprocess, time, json, pathlib, xml.etree.ElementTree as ET, fcntl
import gi
gi.require_version('Gdk','3.0')
from gi.repository import Gdk, Gio, GLib
root=pathlib.Path(__file__).resolve().parent
repo=pathlib.Path(os.environ['PP_EVIDENCE_REPO'])
home=root/'home'; home.mkdir(exist_ok=True)
data=root/'data'; data.mkdir(exist_ok=True)
env=dict(os.environ,HOME=str(home),XDG_CONFIG_HOME=str(home/'.config'),XDG_CACHE_HOME=str(home/'.cache'),XDG_DATA_HOME=str(home/'.local/share'),WEBKIT_DISABLE_COMPOSITING_MODE='1',LIBGL_ALWAYS_SOFTWARE='1')
log=(root/'process-exit.log').open('w',buffering=1)
def record(s):
    print(s,flush=True); log.write(str(s)+'\n')
def run(args):
    record('$ '+' '.join(map(str,args)))
    p=subprocess.run(args,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
    record(p.stdout); record('command_exit='+str(p.returncode)); return p.stdout
services=[]; app=None
bus=Gio.bus_get_sync(Gio.BusType.SESSION,None)
def call(name,path,interface,method,args=None):
    return bus.call_sync(name,path,interface,method,args,None,Gio.DBusCallFlags.NONE,3000,None).unpack()
def discover():
    for name in call('org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','ListNames')[0]:
        if not name.startswith(':1.') and 'StatusNotifierItem' not in name: continue
        pending=['/']; visited=set()
        while pending:
            path=pending.pop()
            if path in visited: continue
            visited.add(path)
            try:
                xml=ET.fromstring(call(name,path,'org.freedesktop.DBus.Introspectable','Introspect')[0])
                pending.extend(path.rstrip('/')+'/'+n.attrib['name'] for n in xml.findall('node'))
                if any(n.attrib['name']=='org.kde.StatusNotifierItem' for n in xml.findall('interface')):
                    props=call(name,path,'org.freedesktop.DBus.Properties','GetAll',GLib.Variant('(s)',('org.kde.StatusNotifierItem',)))[0]
                    return name,props['Menu']
            except GLib.Error: pass
    return None
def layout(): return call(*address,'com.canonical.dbusmenu','GetLayout',GLib.Variant('(iias)',(0,-1,[])))
def find_item(tree,label):
    if tree[1].get('label')==label: return tree[0]
    for child in tree[2]:
        if hasattr(child,'unpack'): child=child.unpack()
        found=find_item(child,label)
        if found is not None: return found
def shot(name):
    time.sleep(1)
    run(['import','-display',os.environ['DISPLAY'],'-window','root',str(root/name)])
def visible():
    return run(['xdotool','search','--onlyvisible','--name','^Print Partner$']).strip()
def event(label):
    tree=layout(); record('dbus_layout='+repr(tree))
    ident=find_item(tree[1],label); assert ident is not None,label
    record(f"DBus {address} com.canonical.dbusmenu.Event id={ident} event=clicked label={label}")
    record(call(*address,'com.canonical.dbusmenu','Event',GLib.Variant('(isvu)',(ident,'clicked',GLib.Variant('i',0),0))))
try:
    record('HEAD='+subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip())
    run(['uname','-a']); run(['lsb_release','-ds']); run(['date','-u','--iso-8601=seconds'])
    for args in [['openbox'],['tint2','-c',str(root/'tint2rc')]]:
        services.append(subprocess.Popen(args,env=env,stdout=(root/(args[0]+'.log')).open('w'),stderr=subprocess.STDOUT))
    time.sleep(2)
    args=[str(repo/'rust/target/debug/pp-desktop'),'--dev-stage',str(root/'runtime'),'--data',str(data)]
    record('HOME='+str(home)); record('$ '+' '.join(args))
    app=subprocess.Popen(args,env=env,stdout=(root/'native.stdout.log').open('w'),stderr=(root/'native.stderr.log').open('w'))
    record('app_pid='+str(app.pid))
    address=None
    for i in range(120):
        assert app.poll() is None,'App exited during startup'
        address=address or discover()
        if address and 'Service ready' in repr(layout()) and visible(): break
        time.sleep(1)
    else: raise RuntimeError('App/tray not ready')
    time.sleep(8)
    shot('01-native-ready.png')
    marker=json.loads((data/'.desktop-owner.json').read_text()); record('marker='+json.dumps(marker))
    runtime=pathlib.Path(marker['runtime_dir']); sockets=list(runtime.glob('*.sock')); assert sockets
    children={int(v) for p in pathlib.Path(f'/proc/{app.pid}/task').glob('*/children') for v in p.read_text().split()}
    child=next(p for p in children if pathlib.Path(f'/proc/{p}/cmdline').read_bytes().split(b'\0')[0]==os.fsencode(root/'runtime/bin/node'))
    record('node_child_pid='+str(child)); run(['ps','-p',f'{app.pid},{child}','-o','pid,ppid,stat,etime,args'])
    run(['ls','-la',str(data/'.desktop.lock'),str(data/'.desktop-owner.json'),str(data/'.desktop-lease'),*map(str,sockets)])
    wid=visible().splitlines()[0]
    run(['xdotool','windowactivate','--sync',wid,'key','alt+F4'])
    time.sleep(3)
    record('AFTER WINDOW CLOSE'); assert not visible(),'Window remains mapped'; assert app.poll() is None
    run(['ps','-p',f'{app.pid},{child}','-o','pid,ppid,stat,etime,args'])
    shot('02-closed-tray-only.png')
    run(['xdotool','mousemove','1418','982','click','3'])
    shot('03-tray-menu.png'); record('after_close_menu='+repr(layout()))
    run(['xdotool','key','Escape'])
    event('Show Print Partner'); time.sleep(3); assert visible(),'Show did not restore window'
    shot('04-restored-window.png')
    run(['ps','-p',f'{app.pid},{child}','-o','pid,ppid,stat,etime,args'])
    run(['xdotool','mousemove','1418','982','click','3']); shot('05-tray-quit-menu.png')
    run(['xdotool','key','Escape']); event('Quit Print Partner')
    code=app.wait(timeout=30); record('TRAY_QUIT_EXIT_CODE='+str(code)); assert code==0
    record('AFTER TRAY QUIT')
    run(['ps','-p',f'{app.pid},{child}','-o','pid,ppid,stat,etime,args'])
    assert not pathlib.Path(f'/proc/{child}').exists(),'Node child survives'
    for p in [data/'.desktop-owner.json',data/'.desktop-lease',runtime,*sockets]:
        record(str(p)+' exists='+str(p.exists())); assert not p.exists()
    p=data/'.desktop.lock'; record(str(p)+' exists='+str(p.exists())+' (retained by implementation)')
    with p.open('r+') as probe:
        fcntl.flock(probe,fcntl.LOCK_EX|fcntl.LOCK_NB); record('flock LOCK_EX|LOCK_NB on retained .desktop.lock: SUCCESS (lock released)'); fcntl.flock(probe,fcntl.LOCK_UN)
    run(['cat',str(root/'native.stdout.log')]); run(['ls','-la',str(data)])
    shot('06-after-quit.png')
    record('RESULT: close/show/quit assertions passed; persistent lock file explicitly retained')
finally:
    if app and app.poll() is None:
        record('Capture exception: terminating only capture-owned app'); app.terminate()
        try: app.wait(timeout=30)
        except subprocess.TimeoutExpired: app.kill(); app.wait()
    for service in services: service.terminate(); service.wait(timeout=10)
    log.close()
