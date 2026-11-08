// A small fake DOM for the launcher bar tests (launcherShell.test.ts): just what the bar touches. innerHTML,
// outerHTML and insertAdjacentHTML throw so any use of them on agent data fails a test.
export type Listener = (ev: FakeEvent) => void;
interface Reg {
  fn: Listener;
  capture: boolean;
}

export interface FakeEvent {
  type: string;
  target?: unknown;
  key?: string;
  code?: string;
  altKey?: boolean;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  defaultPrevented?: boolean;
  propagationStopped?: boolean;
  preventDefault?: () => void;
  stopPropagation?: () => void;
  [k: string]: unknown;
}

export function makeEvent(type: string, init: Record<string, unknown> = {}): FakeEvent {
  const ev: FakeEvent = { type, defaultPrevented: false, propagationStopped: false, ...init };
  ev.preventDefault = () => {
    ev.defaultPrevented = true;
  };
  ev.stopPropagation = () => {
    ev.propagationStopped = true;
  };
  return ev;
}

export class Node_ {
  tagName: string;
  className = "";
  hidden = false;
  disabled = false;
  value = "";
  type = "";
  id = "";
  title = "";
  files: unknown[] | null = null;
  children: Node_[] = [];
  parent: Node_ | null = null;
  attrs = new Map<string, string>();
  listeners = new Map<string, Reg[]>();
  focused = 0;
  clicks = 0;
  scrolled = 0;
  private text = "";
  constructor(tag: string) {
    this.tagName = tag;
  }
  get parentNode(): Node_ | null {
    return this.parent;
  }
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    this.text = String(v);
    for (const c of [...this.children]) c.remove();
  }
  set innerHTML(_v: string) {
    throw new Error("innerHTML is forbidden");
  }
  get innerHTML(): string {
    throw new Error("innerHTML is forbidden");
  }
  set outerHTML(_v: string) {
    throw new Error("outerHTML is forbidden");
  }
  get outerHTML(): string {
    throw new Error("outerHTML is forbidden");
  }
  insertAdjacentHTML(): void {
    throw new Error("insertAdjacentHTML is forbidden");
  }
  appendChild(c: Node_) {
    c.remove();
    c.parent = this;
    this.children.push(c);
    return c;
  }
  remove() {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  replaceChildren() {
    this.text = "";
    for (const c of [...this.children]) c.remove();
  }
  contains(n: unknown): boolean {
    for (let cur = n as Node_ | null; cur; cur = cur.parent) if (cur === this) return true;
    return false;
  }
  setAttribute(k: string, v: string) {
    this.attrs.set(k, String(v));
  }
  getAttribute(k: string) {
    return this.attrs.get(k) ?? null;
  }
  removeAttribute(k: string) {
    this.attrs.delete(k);
  }
  addEventListener(t: string, fn: Listener, capture?: boolean) {
    const l = this.listeners.get(t) ?? [];
    l.push({ fn, capture: !!capture });
    this.listeners.set(t, l);
  }
  // Runs this node's own listeners only (no bubbling); tests that need bubbling use FakeDocument.dispatch.
  fire(t: string, init: Record<string, unknown> = {}): FakeEvent {
    const ev = makeEvent(t, { target: this, ...init });
    for (const { fn } of this.listeners.get(t) ?? []) fn(ev);
    return ev;
  }
  click() {
    this.clicks++;
    this.fire("click");
  }
  focus() {
    this.focused++;
  }
  scrollIntoView() {
    this.scrolled++;
  }
  get classList() {
    const names = () => this.className.split(" ").filter(Boolean);
    return {
      contains: (n: string) => names().includes(n),
      add: (n: string) => {
        this.className = [...new Set([...names(), n])].join(" ");
      },
      remove: (n: string) => {
        this.className = names()
          .filter((x) => x !== n)
          .join(" ");
      },
      toggle: (n: string, force: boolean) => {
        const set = new Set(names());
        if (force) set.add(n);
        else set.delete(n);
        this.className = [...set].join(" ");
      },
    };
  }
  all(): Node_[] {
    return [this, ...this.children.flatMap((c) => c.all())];
  }
  byClass(c: string): Node_[] {
    return this.all().filter((n) => n.className.split(" ").includes(c));
  }
  byTag(t: string): Node_[] {
    return this.all().filter((n) => n.tagName === t);
  }
}

export class FakeDocument {
  hidden = false;
  body = new Node_("body");
  byId = new Map<string, Node_>();
  listeners = new Map<string, Reg[]>();
  getElementById = (id: string) => this.byId.get(id) ?? null;
  createElement = (tag: string) => new Node_(tag);
  addEventListener = (t: string, fn: Listener, capture?: boolean) => {
    const l = this.listeners.get(t) ?? [];
    l.push({ fn, capture: !!capture });
    this.listeners.set(t, l);
  };
  // Real event order: document capture listeners, then the target's own listeners, then document bubble listeners.
  // A capture listener that calls stopPropagation hides the event from everything after it.
  dispatch(target: Node_, type: string, init: Record<string, unknown> = {}): FakeEvent {
    const ev = makeEvent(type, { target, ...init });
    const docs = this.listeners.get(type) ?? [];
    for (const { fn } of docs.filter((l) => l.capture)) fn(ev);
    if (ev.propagationStopped) return ev;
    for (const { fn } of target.listeners.get(type) ?? []) fn(ev);
    if (ev.propagationStopped) return ev;
    for (const { fn } of docs.filter((l) => !l.capture)) fn(ev);
    return ev;
  }
}
