// Sound effects via Web Audio, music via a single <audio> element.
const BASE = import.meta.env.BASE_URL + 'assets/';

import type { SoundName, Sounds } from './game/tetrisField.ts';

const SFX: Record<SoundName, string> = {
  gameOver: 'sfx/game-over.wav',
  impact: 'sfx/impact.wav',
  clear: 'sfx/impactd.mp3',
  tetris: 'sfx/impactf.mp3',
  boom: 'sfx/boom.mp3',
};

const SONGS = [
  'music/Arcade.mp3',
  'music/Better Days.mp3',
  'music/The Process.mp3',
  'music/zelda-lost-woods.mp3',
  'music/Liquid Stranger - Dissolve.mp3',
];

export class Audio implements Sounds {
  ctx: AudioContext | null;
  buffers: Partial<Record<SoundName, AudioBuffer>>;
  music: HTMLAudioElement;
  musicStarted: boolean;
  blocked: boolean;
  failures: number;

  constructor() {
    this.ctx = null;
    this.buffers = {};
    this.music = new window.Audio();
    this.music.volume = 0.5;
    this.musicStarted = false;
    // Browsers refuse playback until a user gesture; gamepad presses don't
    // count, so a game started from a controller waits for a key or click.
    this.blocked = false;
    this.failures = 0;

    this.music.addEventListener('ended', () => this.playRandomSong());
    this.music.addEventListener('playing', () => {
      this.failures = 0;
    });
    this.music.addEventListener('error', () => {
      // Try another track; give up only once every track has failed in a row.
      this.failures++;
      this.musicStarted = false;
      if (this.failures < SONGS.length) this.playRandomSong();
    });

    const onGesture = () => {
      this.blocked = false;
      if (this.ctx?.state === 'suspended') this.ctx.resume().catch(() => {});
    };
    window.addEventListener('keydown', onGesture);
    window.addEventListener('pointerdown', onGesture);
  }

  get musicDisabled(): boolean {
    return this.failures >= SONGS.length;
  }

  /** Call when the game starts; loads the sound effects. */
  async unlock() {
    if (this.ctx) return;
    const Ctx =
      window.AudioContext || (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;
    ctx.resume().catch(() => {});
    await Promise.all(
      (Object.entries(SFX) as [SoundName, string][]).map(async ([name, path]) => {
        try {
          const res = await fetch(BASE + encodeURI(path));
          this.buffers[name] = await ctx.decodeAudioData(await res.arrayBuffer());
        } catch {
          // Missing or undecodable sound: play silently.
        }
      }),
    );
  }

  play(name: SoundName, volume = 1) {
    const buffer = this.buffers[name];
    if (!this.ctx || !buffer || this.ctx.state !== 'running') return;
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
    this.resumeMusic();
  }

  resumeMusic() {
    this.music.play().catch((err) => {
      if ((err as Error | undefined)?.name === 'NotAllowedError') this.blocked = true;
    });
  }

  /** Mirrors the MediaPlayer handling at the top of GameScreen.Update. */
  update({ paused, stopped }: { paused: boolean; stopped: boolean }) {
    if (!this.ctx || this.musicDisabled) return;
    if (stopped) {
      if (this.musicStarted) {
        this.music.pause();
        this.musicStarted = false;
      }
      return;
    }
    if (paused) {
      if (!this.music.paused) this.music.pause();
    } else if (this.music.paused && !this.blocked) {
      if (this.musicStarted) this.resumeMusic();
      else this.playRandomSong();
    }
  }
}
