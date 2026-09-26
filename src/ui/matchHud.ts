// In-match status for online play: the win counter bar, a "joined" toast, and
// a panel for the result, pause, reconnecting and the end of the room.
// Names only ever go in through textContent.
import { ERROR_TEXT } from './lobby.ts';
import type { CloseReason, Session } from '../net/session.ts';

const TOAST_MS = 3000;

/** What ends the room, as shown to the player. `them` is the opponent's name. */
export function closeText(reason: CloseReason | null, them: string): string {
  switch (reason) {
    case 'bye':
      return `${them} LEFT`;
    case 'forfeit-win':
      return `${them} LEFT, YOU WIN`;
    case 'forfeit-lose':
      return 'YOU LEFT, YOU LOSE';
    case 'lost':
      return 'CONNECTION LOST';
    default:
      return ERROR_TEXT[reason ?? ''] ?? ERROR_TEXT.failed;
  }
}

type HudButton = 'rematch' | 'resume' | 'leave' | 'back';

export class MatchHud {
  bar: HTMLElement;
  score: HTMLElement;
  ping: HTMLElement;
  root: HTMLElement;
  toastBox: HTMLElement;
  panel: HTMLElement;
  title: HTMLElement;
  text: HTMLElement;
  buttons: Record<HudButton, HTMLButtonElement>;
  toastTimer: ReturnType<typeof setTimeout> | number;
  onRematch?: () => void;
  onResume?: () => void;
  onLeave?: () => void;
  onBack?: () => void;

  constructor(root: Document = document) {
    const $ = <T extends HTMLElement = HTMLElement>(id: string) => root.getElementById(id) as T;
    this.bar = $('match-bar');
    this.score = $('match-score');
    this.ping = $('match-ping');
    this.root = $('hud');
    this.toastBox = $('hud-toast');
    this.panel = $('hud-panel');
    this.title = $('hud-title');
    this.text = $('hud-text');
    this.buttons = {
      rematch: $<HTMLButtonElement>('hud-rematch'),
      resume: $<HTMLButtonElement>('hud-resume'),
      leave: $<HTMLButtonElement>('hud-leave'),
      back: $<HTMLButtonElement>('hud-back'),
    };
    this.toastTimer = 0;
    // Set by main.ts: onRematch, onResume, onLeave, onBack.
    for (const [name, button] of Object.entries(this.buttons) as [HudButton, HTMLButtonElement][]) {
      const handler = `on${name[0].toUpperCase()}${name.slice(1)}` as `on${Capitalize<HudButton>}`;
      button.addEventListener('click', () => this[handler]?.());
    }
  }

  hide() {
    this.bar.hidden = true;
    this.root.hidden = true;
    this.toastBox.hidden = true;
    clearTimeout(this.toastTimer);
  }

  toast(text: string) {
    this.toastBox.textContent = text;
    this.toastBox.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => (this.toastBox.hidden = true), TOAST_MS);
  }

  /** Shows the room as the session sees it now. */
  render(s: Session) {
    const [me, them] = s.names;
    const [mine, theirs] = s.score;
    this.bar.hidden = false;
    this.root.hidden = false;
    this.score.textContent = `${me} ${mine} - ${theirs} ${them}`;
    // Round trip from ping / pong, while connected.
    this.ping.textContent = s.connected && s.latency !== null ? `${Math.round(s.latency)} MS` : '';

    let title = '';
    let text = '';
    const show = new Set<HudButton>();
    switch (s.state) {
      case 'roundOver':
        title = s.result === 'draw' ? 'DRAW' : `${s.winnerName} WINS`;
        if (s.ready[s.role]) text = `WAITING FOR ${them}...`;
        else if (s.ready[s.other]) text = `${them} IS READY`;
        if (!s.ready[s.role]) show.add('rematch');
        show.add('leave');
        break;
      case 'paused':
        title = 'PAUSED';
        text = s.remoteAway ? `${them} IS AWAY` : '';
        show.add('resume').add('leave');
        break;
      case 'reconnecting':
        title = 'RECONNECTING...';
        text = `${s.graceLeft}`;
        show.add('leave');
        break;
      case 'closed':
        title = closeText(s.closeReason, them);
        show.add('back');
        break;
    }
    this.panel.hidden = title === '';
    this.title.textContent = title;
    this.text.textContent = text;
    for (const [name, button] of Object.entries(this.buttons) as [HudButton, HTMLButtonElement][]) {
      button.hidden = !show.has(name);
    }
  }
}
