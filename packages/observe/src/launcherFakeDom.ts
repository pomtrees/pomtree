// The one fake DOM for the observe shell tests (launcher bar, window manager and window chrome): just what the shell
// code touches. innerHTML, outerHTML and insertAdjacentHTML throw so any use of them on agent data fails a test.
import { inspect } from "node:util";

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

// children and the query helpers index without `| undefined` (tests assert the length first), like a fixed-shape tuple.
// Subclasses may describe a rectangle by right and bottom instead of width and height.
export type Rect = { left: number; top: number } & Partial<Record<"width" | "height" | "right" | "bottom", number>>;
export type NodeList = [Node_, Node_, Node_, Node_, ...Node_[]];

export class Node_ {
  tagName: string;
  className = "";
  hidden = false;
  disabled = false;
  value = "";
  type = "";
  id = "";
  title = "";
  href = "";
  download = "";
  files: unknown[] | null = null;
  children: NodeList = [] as unknown as NodeList;
  parent: Node_ | null = null;
  // The owning document (set by FakeDocument.createElement): focus() records itself as its activeElement.
  doc: FakeDocument | null = null;
  style: Record<string, string> = {};
  rect: Rect = { left: 0, top: 0, width: 1000, height: 600 };
  captured: number[] = [];
  attrs = new Map<string, string>();
  listeners = new Map<string, Reg[]>();
  focused = 0;
  clicks = 0;
  scrolled = 0;
  private text = "";
  constructor(tag: string) {
    this.tagName = tag;
  }
  // Short descriptor so a failing assertion never inspects the parent/listener graph (it once exhausted memory).
  [inspect.custom](): string {
    return `<Node_ ${this.tagName} id=${this.id || (this.attrs.get("id") ?? "")} class="${this.className}" children=${this.children.length}>`.slice(0, 119);
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
  replaceChildren(...cs: Node_[]) {
    this.text = "";
    for (const c of [...this.children]) c.remove();
    for (const c of cs) this.appendChild(c);
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
  removeEventListener(t: string, fn: Listener) {
    this.listeners.set(
      t,
      (this.listeners.get(t) ?? []).filter((r) => r.fn !== fn),
    );
  }
  listenerCount(t: string): number {
    return (this.listeners.get(t) ?? []).length;
  }
  get role(): string | null {
    return this.getAttribute("role");
  }
  // Dispatches ev (target set to this node) along the path fixed at dispatch time, like a browser, so a handler that
  // re-renders does not cut the event short; bubble false runs this node's own listeners only.
  emit(ev: Partial<FakeEvent> & { type: string }, bubble = true): FakeEvent {
    const full = ev as FakeEvent;
    full.defaultPrevented = false;
    full.preventDefault = () => {
      full.defaultPrevented = true;
    };
    full.target = this;
    const path: Node_[] = [];
    for (let n: Node_ | null = this; n; n = bubble ? n.parent : null) path.push(n);
    for (const n of path) for (const { fn } of [...(n.listeners.get(full.type) ?? [])]) fn(full);
    return full;
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
    if (this.doc) this.doc.activeElement = this;
    this.fire("focus");
  }
  setPointerCapture(id: number) {
    this.captured.push(id);
  }
  releasePointerCapture() {}
  getBoundingClientRect() {
    return this.rect;
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
  byClass(c: string): NodeList {
    return this.all().filter((n) => n.className.split(" ").includes(c)) as NodeList;
  }
  byTag(t: string): Node_[] {
    return this.all().filter((n) => n.tagName === t);
  }
}

export class FakeDocument extends Node_ {
  hidden = false;
  activeElement: Node_ | null = null;
  body: Node_;
  byId = new Map<string, Node_>();
  constructor() {
    super("#document");
    this.doc = this;
    this.body = this.createElement("body");
    this.appendChild(this.body);
  }
  getElementById = (id: string) => this.byId.get(id) ?? null;
  createElement = (tag: string) => {
    const n = new Node_(tag);
    n.doc = this;
    return n;
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
