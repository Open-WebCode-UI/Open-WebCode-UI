import { spawn } from 'node:child_process';

// A tiny notebook "kernel": one long-lived `python3` per (user, project, notebook), so variables and imports carry from one cell to the
// next. It needs only Python 3 on the server (no Jupyter / ipykernel). The driver below reads one JSON request per line on stdin and
// reports on fd 3, so a cell's own prints can never be mistaken for protocol.
const DRIVER = String.raw`
import sys, os, json, ast, signal, traceback, base64, io, warnings
warnings.filterwarnings('ignore', message='.*non-interactive.*')
chan = os.fdopen(3, 'w', buffering=1)
def emit(o):
    chan.write(json.dumps(o) + "\n"); chan.flush()
class Out:
    def __init__(self, name): self.name = name
    def write(self, t):
        if t: emit({'t': 'stream', 'name': self.name, 'text': t})
        return len(t)
    def flush(self): pass
    def isatty(self): return False
sys.stdout, sys.stderr = Out('stdout'), Out('stderr')
# Rich display, like IPython: an object offers its own renderings through _repr_*_ methods (pandas tables, PIL images, ...).
MIMES = (('image/png', '_repr_png_'), ('image/jpeg', '_repr_jpeg_'), ('image/svg+xml', '_repr_svg_'), ('text/html', '_repr_html_'), ('text/markdown', '_repr_markdown_'), ('text/latex', '_repr_latex_'))
def bundle(o):
    d = {}
    for mime, meth in MIMES:
        try:
            f = getattr(o, meth, None)
            v = f() if callable(f) else None
            if isinstance(v, tuple): v = v[0]
            if v is None: continue
            if isinstance(v, bytes): v = base64.b64encode(v).decode() if mime.startswith('image/') and mime != 'image/svg+xml' else v.decode('utf-8', 'replace')
            d[mime] = v
        except Exception:
            pass
    d['text/plain'] = repr(o)
    return d
def display(*objs):
    for o in objs: emit({'t': 'display', 'data': bundle(o)})
# Like the inline backend: every figure left open by a cell is shown as an image, then closed.
def flush_figures():
    plt = sys.modules.get('matplotlib.pyplot')
    if plt is None: return
    try:
        for n in plt.get_fignums():
            buf = io.BytesIO(); plt.figure(n).savefig(buf, format='png', bbox_inches='tight')
            emit({'t': 'display', 'data': {'image/png': base64.b64encode(buf.getvalue()).decode(), 'text/plain': '<Figure>'}})
    except Exception:
        pass
    finally:
        try: plt.close('all')
        except Exception: pass
running = False
def on_int(sig, frm):
    if running: raise KeyboardInterrupt()
signal.signal(signal.SIGINT, on_int)
g = {'__name__': '__main__', 'display': display}
sys.path.insert(0, os.getcwd())
count = 0
stdin = sys.stdin
sys.stdin = open(os.devnull)
def skip_driver(tb):
    while tb is not None and tb.tb_frame.f_code.co_filename == '<string>': tb = tb.tb_next
    return tb
for line in stdin:
    req = json.loads(line); count += 1
    running = True
    try:
        tree = ast.parse(req['code'], '<cell>')
        last = ast.Expression(tree.body.pop().value) if tree.body and isinstance(tree.body[-1], ast.Expr) else None
        exec(compile(tree, '<cell>', 'exec'), g)
        if last is not None:
            v = eval(compile(last, '<cell>', 'eval'), g)
            if v is not None:
                g['_'] = v
                emit({'t': 'result', 'data': bundle(v)})
    except BaseException as e:
        running = False
        tb = traceback.format_exception(type(e), e, skip_driver(e.__traceback__))
        emit({'t': 'error', 'ename': type(e).__name__, 'evalue': str(e), 'traceback': [''.join(tb)]})
    running = False
    flush_figures()
    emit({'t': 'done', 'id': req['id'], 'count': count})
`;

const OUTPUT_CAP = 1_000_000; // characters of output per cell run
const baseEnv = (cwd) => ({ PATH: process.env.PATH, HOME: cwd, LANG: process.env.LANG?.includes('UTF-8') ? process.env.LANG : 'en_US.UTF-8', PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', MPLBACKEND: 'Agg' }); // never the server's secrets

export class KernelSession {
  constructor({ cwd, python = 'python3', killAfterMs = 3000 }) {
    Object.assign(this, { cwd, dead: false, current: null, queue: Promise.resolve(), lastActive: Date.now(), killAfterMs, seq: 0 });
    this.child = spawn(python, ['-u', '-c', DRIVER], { cwd, env: baseEnv(cwd), stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    let buf = ''; this.child.stdio[3].setEncoding('utf8').on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { this.#event(JSON.parse(l)); } catch { /* not ours */ } } });
    // Output from child processes the cell starts (os.system, subprocess) bypasses sys.stdout.
    this.child.stdout.setEncoding('utf8').on('data', (t) => this.#event({ t: 'stream', name: 'stdout', text: t }));
    this.child.stderr.setEncoding('utf8').on('data', (t) => this.#event({ t: 'stream', name: 'stderr', text: t }));
    this.child.stdin.on('error', () => {});
    this.child.on('error', (e) => this.#died(e.code === 'ENOENT' ? 'python3 was not found on the server.' : `Could not start Python: ${e.message}`));
    this.child.on('close', () => this.#died('The kernel stopped.'));
  }
  #event(ev) {
    const cur = this.current; if (!cur) return;
    if (ev.t === 'stream') { cur.size += ev.text.length; if (cur.size > OUTPUT_CAP) { if (!cur.capped) { cur.capped = true; cur.onEvent({ t: 'stream', name: 'stderr', text: '\n[output truncated]\n' }); } return; } }
    if (ev.data) { cur.size += JSON.stringify(ev.data).length; if (cur.size > OUTPUT_CAP) ev = { ...ev, data: { 'text/plain': ev.data['text/plain'] ?? '[output too large]' } }; } // rich output is bounded too
    if (ev.t === 'done') { this.current = null; clearTimeout(this.killTimer); cur.onEvent(ev); cur.resolve(); return; }
    cur.onEvent(ev);
  }
  #died(message) {
    this.dead = true; clearTimeout(this.killTimer);
    const cur = this.current; this.current = null;
    if (cur) { cur.onEvent({ t: 'error', ename: 'KernelDied', evalue: message, traceback: [message] }); cur.onEvent({ t: 'done', id: cur.id, count: null }); cur.resolve(); }
  }
  // Runs one cell; cells on the same kernel run one at a time. onEvent gets stream / result / error / done events.
  run(code, onEvent) {
    const job = this.queue.then(() => new Promise((resolve) => {
      if (this.dead) { onEvent({ t: 'error', ename: 'KernelDied', evalue: 'The kernel is not running.', traceback: ['The kernel is not running.'] }); onEvent({ t: 'done', count: null }); return resolve(); }
      this.lastActive = Date.now(); const id = ++this.seq;
      this.current = { id, onEvent, resolve, size: 0, capped: false };
      this.child.stdin.write(`${JSON.stringify({ id, code })}\n`);
    }));
    this.queue = job.catch(() => {}); return job;
  }
  // Ctrl-C for the running cell. A cell that ignores it (stuck in C code) is killed after a grace period, which loses the kernel's state.
  interrupt() {
    if (this.dead || !this.current) return false;
    try { this.child.kill('SIGINT'); } catch { /* gone */ }
    clearTimeout(this.killTimer); this.killTimer = setTimeout(() => this.kill(), this.killAfterMs); this.killTimer.unref?.();
    return true;
  }
  kill() { clearTimeout(this.killTimer); try { this.child.kill('SIGKILL'); } catch { /* gone */ } }
}

export class KernelManager {
  constructor({ idleMs = 30 * 60_000, maxPerUser = 4, python } = {}) {
    Object.assign(this, { idleMs, maxPerUser, python, sessions: new Map() });
    this.sweeper = setInterval(() => this.sweep(), 60_000); this.sweeper.unref();
  }
  key(userId, projectId, file) { return `${userId}:${projectId}:${file}`; }
  get(userId, projectId, file) { const s = this.sessions.get(this.key(userId, projectId, file)); return s && !s.dead ? s : null; }
  create(userId, projectId, file, cwd) {
    const existing = this.get(userId, projectId, file); if (existing) return existing;
    this.sessions.delete(this.key(userId, projectId, file));
    const mine = [...this.sessions.entries()].filter(([k, s]) => k.startsWith(`${userId}:`) && !s.dead);
    if (mine.length >= this.maxPerUser) { const err = new Error('too_many_kernels'); err.status = 429; throw err; }
    const s = new KernelSession({ cwd, python: this.python }); this.sessions.set(this.key(userId, projectId, file), s); return s;
  }
  restart(userId, projectId, file) { const s = this.sessions.get(this.key(userId, projectId, file)); if (s) { s.kill(); this.sessions.delete(this.key(userId, projectId, file)); } }
  killWhere(pred) { for (const [k, s] of this.sessions) if (pred(k, s)) { s.kill(); this.sessions.delete(k); } }
  killAll() { this.killWhere(() => true); }
  killForProject(projectId) { this.killWhere((k) => k.split(':')[1] === String(projectId)); }
  killForUser(userId) { this.killWhere((k) => k.startsWith(`${userId}:`)); }
  sweep() { const now = Date.now(); this.killWhere((_k, s) => s.dead || (!s.current && now - s.lastActive > this.idleMs)); }
}
export const kernels = new KernelManager();
