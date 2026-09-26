// Create / join screens shown inside the start overlay.
import { CODE_LENGTH, codeFromInput, normalizeCode } from '../net/joinCode.ts';
import { cleanName, loadName, normalizeNameInput, saveName } from '../net/playerName.ts';

export const ERROR_TEXT: Record<string, string> = {
  'not-found': 'NO ROOM WITH THAT CODE',
  full: 'ROOM IS FULL',
  failed: "COULDN'T CONNECT. TRY BOTH DEVICES ON THE SAME WI-FI.",
  version: 'YOUR OPPONENT IS ON A DIFFERENT VERSION. RELOAD THE PAGE.',
  taken: "COULDN'T CREATE A ROOM. TRY AGAIN.",
  lost: 'CONNECTION LOST',
  load: "COULDN'T LOAD ONLINE PLAY. CHECK THE CONNECTION OR RELOAD THE PAGE.",
};

/** Replaces an input's value without jumping the caret when nothing changed. */
function setValue(input: HTMLInputElement, value: string) {
  if (input.value !== value) input.value = value;
}

export type LobbyMode = 'create' | 'join';

export class Lobby {
  panel: HTMLFormElement;
  title: HTMLElement;
  nameInput: HTMLInputElement;
  hostBox: HTMLElement;
  codeText: HTMLElement;
  shareButton: HTMLButtonElement;
  qr: HTMLCanvasElement;
  shareNote: HTMLElement;
  joinUrl: string | null;
  joinBox: HTMLElement;
  codeInput: HTMLInputElement;
  joinButton: HTMLButtonElement;
  status: HTMLElement;
  cancelButton: HTMLButtonElement;
  mode: LobbyMode | null;
  busy: boolean;
  onJoin: ((name: string, code: string) => void) | null;
  onNameChange: ((name: string) => void) | null;
  onCancel: (() => void) | null;

  constructor(root: Document = document) {
    const $ = <T extends HTMLElement = HTMLElement>(id: string) => root.getElementById(id) as T;
    this.panel = $<HTMLFormElement>('lobby');
    this.title = $('lobby-title');
    this.nameInput = $<HTMLInputElement>('lobby-name');
    this.hostBox = $('lobby-host');
    this.codeText = $('room-code');
    this.shareButton = $<HTMLButtonElement>('lobby-share');
    this.qr = $<HTMLCanvasElement>('lobby-qr');
    this.shareNote = $('share-note');
    this.joinUrl = null;
    this.joinBox = $('lobby-join');
    this.codeInput = $<HTMLInputElement>('lobby-code');
    this.joinButton = $<HTMLButtonElement>('lobby-join-go');
    this.status = $('lobby-status');
    this.cancelButton = $<HTMLButtonElement>('lobby-cancel');
    this.mode = null; // 'create' | 'join'
    this.busy = false;
    this.onJoin = null; // (name, code) => void
    this.onNameChange = null; // (name) => void
    this.onCancel = null;

    this.nameInput.addEventListener('input', () => {
      setValue(this.nameInput, normalizeNameInput(this.nameInput.value));
      this.onNameChange?.(cleanName(this.nameInput.value));
    });
    this.codeInput.addEventListener('input', () => {
      setValue(this.codeInput, codeFromInput(this.codeInput.value));
      this.setStatus('');
      // Connect on our own once the code is complete, unless a tap is needed first.
      if (this.joinButton.hidden) this.submitJoin();
    });
    this.panel.addEventListener('submit', (e) => {
      e.preventDefault();
      if (this.mode === 'join') this.submitJoin();
      else this.nameInput.blur();
    });
    this.joinButton.addEventListener('click', (e) => {
      e.preventDefault();
      this.joinButton.hidden = true;
      this.submitJoin();
    });
    this.cancelButton.addEventListener('click', () => this.onCancel?.());
    this.shareButton.addEventListener('click', () => this.share());
    // Keep clicks in the panel away from the overlay's "tap to start solo".
    this.panel.addEventListener('click', (e) => e.stopPropagation());
  }

  get isOpen(): boolean {
    return this.mode !== null;
  }

  /** The name to use, remembered for next time. */
  get name(): string {
    const name = cleanName(this.nameInput.value);
    saveName(name);
    return name;
  }

  open(mode: LobbyMode) {
    this.mode = mode;
    this.busy = false;
    setValue(this.nameInput, loadName());
    this.nameInput.disabled = false;
    this.title.textContent = mode === 'create' ? 'CREATE ROOM' : 'JOIN ROOM';
    this.hostBox.hidden = mode !== 'create';
    this.joinBox.hidden = mode !== 'join';
    this.codeText.textContent = '';
    this.shareButton.hidden = true;
    this.qr.hidden = true;
    this.shareNote.textContent = '';
    this.joinUrl = null;
    this.setStatus('');
    this.panel.hidden = false;
  }

  openCreate() {
    this.open('create');
  }

  /** @param tapToJoin show a Tap to join button (needed before audio can play) */
  openJoin(code: string | null = '', { tapToJoin = false }: { tapToJoin?: boolean } = {}) {
    this.open('join');
    this.codeInput.disabled = false;
    setValue(this.codeInput, normalizeCode(code));
    this.joinButton.hidden = !tapToJoin;
    if (!tapToJoin && !document.body.classList.contains('touch')) this.codeInput.focus();
  }

  close() {
    this.mode = null;
    this.panel.hidden = true;
    // A hidden field keeping focus would still swallow game keys.
    const focused = document.activeElement as HTMLElement | null;
    if (this.panel.contains(focused)) focused?.blur();
  }

  submitJoin() {
    const code = this.codeInput.value;
    if (this.busy || code.length !== CODE_LENGTH) return;
    this.onJoin?.(this.name, code);
  }

  /** While connecting, the name and code are fixed. */
  setBusy(busy: boolean) {
    this.busy = busy;
    this.nameInput.disabled = busy && this.mode === 'join';
    this.codeInput.disabled = busy;
  }

  /** The host's code, with a share button and a QR code of the join link. */
  showCode(code: string, joinUrl: string) {
    if (this.joinUrl === joinUrl) return;
    this.codeText.textContent = code;
    this.joinUrl = joinUrl;
    this.shareButton.hidden = false;
    // Only loaded when a room is created, so solo play never downloads it.
    import('lean-qr')
      .then(({ generate }) => {
        if (this.joinUrl !== joinUrl) return;
        generate(joinUrl).toCanvas(this.qr, { on: [0, 0, 0, 255], off: [255, 255, 255, 255], pad: 2 });
        this.qr.hidden = false;
      })
      .catch(() => {
        // No QR code; the code and the share link still work.
      });
  }

  /** Web Share where there is one, else copy the link. */
  async share() {
    const url = this.joinUrl;
    if (!url) return;
    if (navigator.share) {
      try {
        await navigator.share({ url });
        return;
      } catch (err) {
        if ((err as Error | undefined)?.name === 'AbortError') return; // the player closed the share sheet
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      this.shareNote.textContent = 'LINK COPIED';
    } catch {
      this.shareNote.textContent = url;
    }
  }

  setStatus(text: string, tone = '') {
    this.status.textContent = text;
    this.status.dataset.tone = tone;
  }

  showError(reason: string | null) {
    this.setStatus(ERROR_TEXT[reason ?? ''] ?? ERROR_TEXT.failed, 'error');
  }
}
