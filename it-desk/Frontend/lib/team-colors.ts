/**
 * 24 team colours. Teams get a colour by their position in the team directory
 * (stable across sessions and identical for everyone), and the order of hues
 * is spread out so neighbouring teams never look alike.
 */
export type TeamColor = {
  /** Solid swatch (legend dots, selected tiles). */
  fill: string;
  /** Tile background. */
  soft: string;
  /** Tile border. */
  line: string;
  /** Text on the soft background. */
  ink: string;
};

export const TEAM_COLOR_COUNT = 24;

/** Visiting hues 7 steps apart (7 is coprime with 24) keeps consecutive teams far apart on the wheel. */
const HUES = Array.from({ length: TEAM_COLOR_COUNT }, (_, i) => ((i * 7) % TEAM_COLOR_COUNT) * 15 + 8);

export const TEAM_COLORS: readonly TeamColor[] = HUES.map((h, i) => {
  // Quiet, desaturated tints (the accent orange is kept for selection);
  // two lightness bands so close hues still read apart.
  const band = i % 2 === 0;
  return {
    fill: `oklch(${band ? 0.68 : 0.62} 0.085 ${h})`,
    soft: `oklch(${band ? 0.93 : 0.91} 0.045 ${h})`,
    line: `oklch(${band ? 0.64 : 0.62} 0.08 ${h})`,
    ink: `oklch(0.32 0.075 ${h})`,
  };
});

export const NO_TEAM_COLOR: TeamColor = {
  fill: "oklch(0.78 0 0)",
  soft: "oklch(0.99 0 0)",
  line: "oklch(0.64 0 0)",
  ink: "oklch(0.36 0 0)",
};

/** Colour for a team, by its index in the directory order. */
export function teamColorAt(index: number): TeamColor {
  if (index < 0) return NO_TEAM_COLOR;
  return TEAM_COLORS[index % TEAM_COLOR_COUNT];
}

/** Lookup table team id → colour for a directory order. */
export function teamColorMap(teamIds: readonly string[]): Record<string, TeamColor> {
  return Object.fromEntries(teamIds.map((id, i) => [id, teamColorAt(i)]));
}
