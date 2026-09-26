// Create / join screens shown inside the start overlay.
import { CODE_LENGTH, normalizeCode } from '../net/joinCode.js';
import { cleanName, loadName, normalizeNameInput, saveName } from '../net/playerName.js';

export const ERROR_TEXT = {
  'not-found': 'NO ROOM WITH THAT CODE',
  full: 'ROOM IS FULL',
  failed: "COULDN'T CONNECT. TRY BOTH DEVICES ON THE SAME WI-FI.",
  version: 'YOUR OPPONENT IS ON A DIFFERENT VERSION. RELOAD THE PAGE.',
  taken: "COULDN'T CREATE A ROOM. TRY AGAIN.",
  lost: 'CONNECTION LOST',
};

/** Replaces an input's value without jumping the caret when nothing changed. */
function setValue(input, value) {
  if (input.value !== value) input.value = value;
}

export class Lobby {
  constructor(root = document) {
    const $ = (id) => root.getElementById(id);
    this.panel = $('lobby');
    this.title = $('lobby-title');
    this.nameInput = $('lobby-name');
    this.hostBox = $('lobby-host');
    this.codeText = $('room-code');
    this.joinBox = $('lobby-join');
    this.codeInput = $('lobby-code');
    this.joinButton = $('lobby-join-go');
    this.status = $('lobby-status');
    this.cancelButton = $('lobby-cancel');
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
      setValue(this.codeInput, normalizeCode(this.codeInput.value));
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
    // Keep clicks in the panel away from the overlay's "tap to start solo".
    this.panel.addEventListener('click', (e) => e.stopPropagation());
  }

  get isOpen() {
    return this.mode !== null;
  }

  /** The name to use, remembered for next time. */
  get name() {
    const name = cleanName(this.nameInput.value);
    saveName(name);
    return name;
  }

  open(mode) {
    this.mode = mode;
    this.busy = false;
    setValue(this.nameInput, loadName());
    this.nameInput.disabled = false;
    this.title.textContent = mode === 'create' ? 'CREATE ROOM' : 'JOIN ROOM';
    this.hostBox.hidden = mode !== 'create';
    this.joinBox.hidden = mode !== 'join';
    this.codeText.textContent = '';
    this.setStatus('');
    this.panel.hidden = false;
  }

  openCreate() {
    this.open('create');
  }

  /** @param tapToJoin show a Tap to join button (needed before audio can play) */
  openJoin(code = '', { tapToJoin = false } = {}) {
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
    if (this.panel.contains(document.activeElement)) document.activeElement.blur();
  }

  submitJoin() {
    const code = this.codeInput.value;
    if (this.busy || code.length !== CODE_LENGTH) return;
    this.onJoin?.(this.name, code);
  }

  /** While connecting, the name and code are fixed. */
  setBusy(busy) {
    this.busy = busy;
    this.nameInput.disabled = busy && this.mode === 'join';
    this.codeInput.disabled = busy;
  }

  lockName() {
    this.nameInput.disabled = true;
  }

  showCode(code) {
    this.codeText.textContent = code;
  }

  setStatus(text, tone = '') {
    this.status.textContent = text;
    this.status.dataset.tone = tone;
  }

  showError(reason) {
    this.setStatus(ERROR_TEXT[reason] ?? ERROR_TEXT.failed, 'error');
  }
}
