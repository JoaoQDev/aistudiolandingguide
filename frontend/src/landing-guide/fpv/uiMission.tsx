import React from 'react';
import type { EngineeringConfig } from '../../navigator/types';
import type { EvaluatedSlotEntry, PlaybackSpeed } from '../state';
import type { MissionSceneState, PlayerPose, PointOfInterest } from './types';

/**
 * Mission HUD + guided briefing for the first-person view: power and comms cards with real
 * dataset values and countdowns, time controls, site switcher and the step-by-step guide.
 *
 * STUB — owned by the GUIDE-UI agent (props may evolve together with AstronautViewport).
 */
export interface MissionHudProps {
  entries: EvaluatedSlotEntry[];
  activeSlotIdx: number;
  onSelectActiveSlot: (index: number) => void;
  epochIdx: number;
  timestampsUtc: string[];
  stepSeconds: number;
  windowStartIdx: number;
  windowEndIdx: number;
  isPlaying: boolean;
  speed: PlaybackSpeed;
  onTogglePlay: () => void;
  onChangeEpoch: (index: number) => void;
  onChangeSpeed: (speed: PlaybackSpeed) => void;
  config: EngineeringConfig;
  /** What the scene draws right now (drawn directions are exaggerated, see missionSky.ts). */
  mission: MissionSceneState;
  /** Current player pose, or null while the 3D scene is not running. */
  getPose: () => PlayerPose | null;
  pointsOfInterest: readonly PointOfInterest[];
}

export const MissionHud: React.FC<MissionHudProps> = () => null;
