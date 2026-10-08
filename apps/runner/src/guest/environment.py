# Run setup in one guest command: write private config from stdin, wait for
# Docker (still starting after a create or restore), and report the environment.
# argv: git config path, agent-browser config path.
# stdin: {"git": text|null, "browser": text|null}
import os, sys, json, time, platform, subprocess

def put(path,text):
    os.makedirs(os.path.dirname(path),exist_ok=True)
    os.chmod(os.path.dirname(path),0o700)
    tmp=path+'.tmp'
    fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
    with os.fdopen(fd,'w') as file:
        file.write(text)
    os.replace(tmp,path)

config=json.load(sys.stdin)
# Git access is required: a failed write fails the command.
if config['git'] is not None:
    put(sys.argv[1],config['git'])

browser=None
if config['browser'] is not None:
    try:
        put(sys.argv[2],config['browser'])
        browser=True
    except OSError:
        browser=False

docker=False
deadline=time.monotonic()+30
while True:
    try:
        docker=subprocess.run(['docker','info'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=max(0.1,deadline-time.monotonic())).returncode==0
    except (OSError,subprocess.TimeoutExpired):
        docker=False
    if docker or time.monotonic()>=deadline:
        break
    time.sleep(0.2)

head=subprocess.run(['git','-C','/workspace','symbolic-ref','--quiet','--short','HEAD'],capture_output=True,text=True)
print(json.dumps({
    'os':platform.system(),
    'shell':os.environ.get('SHELL','/bin/sh'),
    'branch':head.stdout.strip()[:255] if head.returncode==0 else None,
    'browser':browser,
    'docker':docker,
}))
