import os, sys, json, stat, base64, hashlib
ROOT='/workspace'
NAMES=['AGENTS.override.md','AGENTS.md','AGENTS.MD','CLAUDE.md','CLAUDE.MD']
SKILLS=['/workspace/.pi/skills','/workspace/.agents/skills']
entries=[]
files=[]
visited=0
content_bytes=0

def contained(path):
    real=os.path.realpath(path)
    return real if real == ROOT or real.startswith(ROOT + '/') else None

def read(path):
    global content_bytes
    with open(path,'rb') as file:
        if not stat.S_ISREG(os.fstat(file.fileno()).st_mode): raise ValueError('Unsupported resource')
        data=file.read(65537)
    if len(data)>65536 or b'\x00' in data: raise ValueError('Invalid or oversized resource')
    content=data.decode('utf-8','strict')
    content_bytes+=len(data)
    if content_bytes>1048576 or len(files)>=200: raise ValueError('Resource content limit')
    files.append(dict(path=path,canonical=os.path.realpath(path),content=content))

def walk(path,depth,ancestors):
    global visited
    if depth>32: raise ValueError('Resource depth limit')
    real=contained(path)
    if real is None: return
    if real in ancestors: return
    ancestors=ancestors | {real}
    children=sorted(os.scandir(path),key=lambda e:e.name)
    visited+=len(children)
    if visited>10000: raise ValueError('Resource entry limit')
    instruction=next((name for name in NAMES if any(e.name==name and contained(e.path) is not None and e.is_file() for e in children)),None)
    for entry in children:
        if entry.name in ('.git','node_modules'): continue
        target=contained(entry.path)
        if target is None: continue
        is_dir=entry.is_dir()
        if is_dir:
            entries.append(dict(path=entry.path,canonical=target,kind='directory'))
            walk(entry.path,depth+1,ancestors)
        elif entry.is_file():
            in_skills=any(entry.path.startswith(root+'/') for root in SKILLS)
            relevant=entry.name==instruction or in_skills and (entry.name.endswith('.md') or entry.name in ('.gitignore','.ignore','.fdignore'))
            if relevant:
                read(entry.path)
            entries.append(dict(path=entry.path,canonical=target,kind='file'))

try:
    walk(ROOT,0,set())
    data=json.dumps(dict(entries=entries,files=files),ensure_ascii=True).encode()
    path=sys.argv[1]
    with open(path,'xb') as output:
        output.write(data)
    print(json.dumps(dict(bytes=len(data),hash=hashlib.sha256(data).hexdigest())))
except (OSError,ValueError,UnicodeError):
    print('Project resource discovery could not complete within its safety limits',file=sys.stderr)
    sys.exit(1)
