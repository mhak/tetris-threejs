// In-match status for online play: the win counter bar, a "joined" toast, and
// a panel for the result, pause, reconnecting and the end of the room.
// Names only ever go in through textContent.
import { ERROR_TEXT } from './lobby.js';

const TOAST_MS = 3000;

/** What ends the room, as shown to the player. `them` is the opponent's name. */
export function closeText(reason, them) {
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
      return ERROR_TEXT[reason] ?? ERROR_TEXT.failed;
  }
}

export class MatchHud {
  constructor(root = document) {
    const $ = (id) => root.getElementById(id);
    this.bar = $('match-bar');
    this.score = $('match-score');
    this.root = $('hud');
    this.toastBox = $('hud-toast');
    this.panel = $('hud-panel');
    this.title = $('hud-title');
    this.text = $('hud-text');
    this.buttons = {
      rematch: $('hud-rematch'),
      resume: $('hud-resume'),
      leave: $('hud-leave'),
      back: $('hud-back'),
    };
    this.toastTimer = 0;
    // Set by main.js: onRematch, onResume, onLeave, onBack.
    for (const [name, button] of Object.entries(this.buttons)) {
      const handler = `on${name[0].toUpperCase()}${name.slice(1)}`;
      button.addEventListener('click', () => this[handler]?.());
    }
  }

  hide() {
    this.bar.hidden = true;
    this.root.hidden = true;
    this.toastBox.hidden = true;
    clearTimeout(this.toastTimer);
  }

  toast(text) {
    this.toastBox.textContent = text;
    this.toastBox.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => (this.toastBox.hidden = true), TOAST_MS);
  }

  /** Shows the room as the session sees it now. */
  render(s) {
    const [me, them] = s.names;
    const [mine, theirs] = s.score;
    this.bar.hidden = false;
    this.root.hidden = false;
    this.score.textContent = `${me} ${mine} - ${theirs} ${them}`;

    let title = '';
    let text = '';
    const show = new Set();
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
    for (const [name, button] of Object.entries(this.buttons)) button.hidden = !show.has(name);
  }
}
