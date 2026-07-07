import type {
  ActionKind,
  CreatureExperience,
  CreatureProfile,
  EpisodeMemory,
  SegmentScore
} from "./types";

export function createAttentionExperience(input: {
  profile: CreatureProfile;
  triggerContent: string;
  relatedMemories: unknown[];
  score: SegmentScore;
  action: ActionKind;
  privacyRisk: number;
}): CreatureExperience {
  void input;
  return {
    earReason: "",
    actionFeeling: "",
    saveFeeling: ""
  };
}

export function createEpisodeExperience(episode: EpisodeMemory, profile: CreatureProfile): CreatureExperience {
  void profile;
  return episode.creatureExperience ?? {
    earReason: "",
    actionFeeling: "",
    saveFeeling: ""
  };
}
