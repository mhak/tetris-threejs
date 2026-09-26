// Sound effects via Web Audio, music via a single <audio> element.
const BASE = import.meta.env.BASE_URL + 'assets/';

const SFX = {
  gameOver: 'sfx/game-over.wav',
  impact: 'sfx/impact.wav',
  clear: 'sfx/impactd.wav',
  tetris: 'sfx/impactf.wav',
  boom: 'sfx/boom.mp3',
};

const SONGS = [
  'music/Arcade.wav',
  'music/Better Days.mp3',
  'music/The Process.mp3',
  'music/zelda-lost-woods.mp3',
  'music/Liquid Stranger - Dissolve.mp3',
];

export class Audio {
  constructor() {
    this.ctx = null;
    this.buffers = {};
    this.music = new window.Audio();
    this.music.volume = 0.5;
    this.music.addEventListener('ended', () => this.playRandomSong());
    this.music.addEventListener('error', () => {
      this.musicFailed = true;
    });
    this.musicFailed = false;
    this.musicStarted = false;
  }

  /** Must be called from a user gesture so browsers allow playback. */
  async unlock() {
    if (this.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    await Promise.all(
      Object.entries(SFX).map(async ([name, path]) => {
        try {
          const res = await fetch(BASE + encodeURI(path));
          this.buffers[name] = await this.ctx.decodeAudioData(await res.arrayBuffer());
        } catch {
          // Missing or undecodable sound: play silently.
        }
      }),
    );
  }

  play(name, volume = 1) {
    const buffer = this.buffers[name];
    if (!this.ctx || !buffer) return;
    const source = this.ctx.createBufferSource();
    const gain = this.ctx.createGain();
    gain.gain.value = volume;
    source.buffer = buffer;
    source.connect(gain).connect(this.ctx.destination);
    source.start();
  }

  playRandomSong() {
    const song = SONGS[Math.floor(Math.random() * SONGS.length)];
    this.music.src = BASE + encodeURI(song);
    this.musicStarted = true;
    this.music.play().catch(() => {});
  }

  /** Mirrors the MediaPlayer handling at the top of GameScreen.Update. */
  update({ paused, stopped }) {
    if (!this.ctx || this.musicFailed) return;
    if (stopped) {
      if (!this.music.paused) {
        this.music.pause();
        this.musicStarted = false;
      }
      return;
    }
    if (paused) {
      if (!this.music.paused) this.music.pause();
    } else if (this.music.paused) {
      if (this.musicStarted) this.music.play().catch(() => {});
      else this.playRandomSong();
    }
  }
}
