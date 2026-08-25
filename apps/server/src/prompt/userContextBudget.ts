// allocateUserContextBudget — user-facing part of the fixed 25% block:
// persona first, note gets the leftover. Deterministic, no HTML.
//
// PASS here is not live wiring.
export interface UserContextBudgetInput {
  totalBudget: number;
  profileTokens: number;
  noteTokens: number;
  profileCap: number | null;
  noteCap: number | null;
}

export interface UserContextBudgetResult {
  profileIncluded: boolean;
  profileTokensUsed: number;
  noteIncluded: boolean;
  noteTokensUsed: number;
}

export function allocateUserContextBudget(input: UserContextBudgetInput): UserContextBudgetResult {
  const { totalBudget, profileTokens, noteTokens } = input;

  if (totalBudget <= 0) {
    return { profileIncluded: false, profileTokensUsed: 0, noteIncluded: false, noteTokensUsed: 0 };
  }

  // persona cap applies before budget accounting
  const cappedProfile = input.profileCap != null ? Math.min(profileTokens, input.profileCap) : profileTokens;
  const profileIncluded = cappedProfile > 0 && cappedProfile <= totalBudget;
  const profileUsed = profileIncluded ? Math.floor(cappedProfile) : 0;
  const remaining = totalBudget - profileUsed;

  const cappedNote = input.noteCap != null ? Math.min(noteTokens, input.noteCap) : noteTokens;
  const noteIncluded = cappedNote > 0 && remaining > 0;
  const noteUsed = noteIncluded ? Math.min(Math.floor(cappedNote), remaining) : 0;

  return {
    profileIncluded,
    profileTokensUsed: profileUsed,
    noteIncluded,
    noteTokensUsed: noteUsed,
  };
}
