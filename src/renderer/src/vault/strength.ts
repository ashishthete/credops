import { MIN_MASTER_PASSWORD } from '../../../shared/vault'

export type Strength = 0 | 1 | 2 | 3 | 4

const LENGTH_STEPS = [MIN_MASTER_PASSWORD, 14, 20]
const CLASSES = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/]

/**
 * A rough 0–4 score: one point per length step (10, 14, 20 characters) plus one each for using
 * three and all four character classes. Anything shorter than the minimum scores 0.
 */
export function passwordStrength(pw: string): Strength {
  if (pw.length < MIN_MASTER_PASSWORD) return 0
  const length = LENGTH_STEPS.filter((n) => pw.length >= n).length
  const classes = CLASSES.filter((re) => re.test(pw)).length
  const variety = (classes >= 3 ? 1 : 0) + (classes >= 4 ? 1 : 0)
  return Math.min(4, length + variety) as Strength
}
