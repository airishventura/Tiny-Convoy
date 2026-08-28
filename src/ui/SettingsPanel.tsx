/**
 * Settings.
 *
 * Quality, motion, audio and units. Every option applies immediately — nothing
 * here needs a restart, and reduced motion is honoured from the OS on first run.
 */

import { memo } from 'react';
import { audio } from '@/game/audio/AudioManager';
import { useSettings, type Quality } from '@/state/useSettings';
import { usePlayer, type CloudState } from '@/state/usePlayer';
import { Button, Divider, Label, Modal } from '@/ui/components';

const QUALITIES: Array<{ id: Quality; name: string; hint: string }> = [
  { id: 'low', name: 'Low', hint: 'No shadows, closer horizon. For laptops on battery.' },
  { id: 'medium', name: 'Medium', hint: 'Shadows on, moderate draw distance.' },
  { id: 'high', name: 'High', hint: 'Full shadows, long horizon, dense scatter.' },
];

const Row = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => (
  <div className="flex items-start justify-between gap-6 py-3">
    <div className="min-w-0">
      <div className="text-sm text-cream">{label}</div>
      {hint && <div className="mt-0.5 text-xs leading-snug text-muted">{hint}</div>}
    </div>
    <div className="shrink-0">{children}</div>
  </div>
);

const Slider = ({ value, onChange, ariaLabel }: { value: number; onChange: (v: number) => void; ariaLabel: string }) => (
  <input
    type="range"
    aria-label={ariaLabel}
    min={0}
    max={1}
    step={0.05}
    value={value}
    onChange={(e) => onChange(Number(e.target.value))}
    className="h-1.5 w-40 cursor-pointer appearance-none rounded-full bg-line"
  />
);

const Toggle = ({ on, onChange, ariaLabel }: { on: boolean; onChange: (v: boolean) => void; ariaLabel: string }) => (
  <button
    role="switch"
    aria-checked={on}
    aria-label={ariaLabel}
    onClick={() => {
      audio.ui('click');
      onChange(!on);
    }}
    className={`relative h-6 w-11 rounded-full border transition-colors ${on ? 'border-ember bg-ember/80' : 'border-line bg-panel-2'}`}
  >
    <span
      className={`absolute top-0.5 h-4.5 w-4.5 rounded-full bg-cream transition-transform ${on ? 'translate-x-5.5' : 'translate-x-0.5'}`}
      style={{ height: '1.05rem', width: '1.05rem' }}
    />
  </button>
);

/**
 * Cloud save is a convenience, so it reports like one: never an alarm, never a
 * spinner that outlives the request, and "off" reads as a fact rather than a
 * fault. The game is identical in every one of these states.
 */
const cloudLine = (cloud: CloudState): string => {
  switch (cloud.status) {
    case 'syncing':
      return 'Backing up…';
    case 'synced':
      return `Backed up ${new Date(cloud.at).toLocaleTimeString()}`;
    case 'error':
      return 'Could not reach the depot. Progress is safe on this machine.';
    case 'offline':
      return 'Off. Progress is kept on this machine only.';
    default:
      return 'Progress is kept on this machine.';
  }
};

export const SettingsPanel = memo(function SettingsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const s = useSettings();
  const resetProgress = usePlayer((p) => p.resetProgress);
  const name = usePlayer((p) => p.profile.name);
  const setName = usePlayer((p) => p.setName);
  const cloud = usePlayer((p) => p.cloud);
  const pullCloud = usePlayer((p) => p.pullCloud);

  return (
    <Modal open={open} onClose={onClose} title="Settings" width="max-w-xl">
      <Label>Crew</Label>
      <Row label="Driver name" hint="Shown on the leaderboard. Kept to plain text.">
        <input
          value={name}
          maxLength={18}
          onChange={(e) => setName(e.target.value)}
          className="w-44 rounded-lg border border-line bg-panel-2 px-3 py-1.5 text-sm text-cream outline-none focus:border-ember"
        />
      </Row>
      <Row label="Cloud save" hint={cloudLine(cloud)}>
        <Button
          size="sm"
          variant="secondary"
          disabled={cloud.status === 'syncing'}
          onClick={() => void pullCloud()}
        >
          {cloud.status === 'syncing' ? 'Syncing…' : 'Sync now'}
        </Button>
      </Row>

      <Divider className="my-2" />
      <Label>Display</Label>
      <Row label="Quality" hint={QUALITIES.find((q) => q.id === s.quality)?.hint}>
        <div className="flex gap-1.5">
          {QUALITIES.map((q) => (
            <Button key={q.id} size="sm" variant={s.quality === q.id ? 'primary' : 'secondary'} onClick={() => s.set('quality', q.id)}>
              {q.name}
            </Button>
          ))}
        </div>
      </Row>
      <Row label="Units">
        <div className="flex gap-1.5">
          <Button size="sm" variant={s.units === 'metric' ? 'primary' : 'secondary'} onClick={() => s.set('units', 'metric')}>
            km/h
          </Button>
          <Button size="sm" variant={s.units === 'imperial' ? 'primary' : 'secondary'} onClick={() => s.set('units', 'imperial')}>
            mph
          </Button>
        </div>
      </Row>

      <Divider className="my-2" />
      <Label>Motion</Label>
      <Row label="Reduced motion" hint="Stops camera shake and softens transitions.">
        <Toggle on={s.reducedMotion} onChange={(v) => s.set('reducedMotion', v)} ariaLabel="Reduced motion" />
      </Row>
      <Row label="Camera shake" hint="Only ever fires on real impacts.">
        <Slider value={s.cameraShake} onChange={(v) => s.set('cameraShake', v)} ariaLabel="Camera shake" />
      </Row>

      <Divider className="my-2" />
      <Label>Audio</Label>
      <Row label="Master">
        <Slider
          value={s.masterVolume}
          onChange={(v) => {
            s.set('masterVolume', v);
            audio.setVolumes(v, s.sfxVolume, s.musicVolume);
          }}
          ariaLabel="Master volume"
        />
      </Row>
      <Row label="Effects">
        <Slider
          value={s.sfxVolume}
          onChange={(v) => {
            s.set('sfxVolume', v);
            audio.setVolumes(s.masterVolume, v, s.musicVolume);
          }}
          ariaLabel="Effects volume"
        />
      </Row>
      <Row label="Radio" hint="Drop MP3s into public/audio to run your own station.">
        <Slider
          value={s.musicVolume}
          onChange={(v) => {
            s.set('musicVolume', v);
            audio.setVolumes(s.masterVolume, s.sfxVolume, v);
          }}
          ariaLabel="Radio volume"
        />
      </Row>

      <Divider className="my-2" />
      <Label>Help</Label>
      <Row label="Show hints" hint="Occasional pointers during a run.">
        <Toggle on={s.showHints} onChange={(v) => s.set('showHints', v)} ariaLabel="Show hints" />
      </Row>

      <Divider className="my-3" />
      <Row label="Reset progress" hint="Scrap, reputation, blueprints, cosmetics and history. Cannot be undone.">
        <Button
          variant="danger"
          size="sm"
          onClick={() => {
            if (window.confirm('Delete all local progress and start over?')) resetProgress();
          }}
        >
          Reset
        </Button>
      </Row>
    </Modal>
  );
});
