/**
 * two-sum (REC-0001): the problem itself — statement, signature, tests and
 * reference solutions — lives in @recx/shared/samples/two-sum, because the
 * judge's integration test judges exactly the same data. Its topic tags and
 * practice help (hints + editorial) live here with the rest of the authored
 * content.
 */
import type { Topic } from "@recx/shared";
import { TWO_SUM } from "@recx/shared/samples/two-sum";
import type { HelpContent } from "./types";

export const TWO_SUM_TOPICS: readonly Topic[] = TWO_SUM.topics;

export const TWO_SUM_HELP: HelpContent = {
  hints: [
    `Start with the most direct idea: try every pair of positions \`(i, j)\`. It gives the right answer — but count how many pairs there are when \`nums\` holds 10⁵ numbers. The slow part is searching the earlier numbers again and again.`,
    `Walk through the array once. When you stand at position \`j\`, the partner you need is the value \`target - nums[j]\`, and it must sit somewhere to your left. If you remember every value you have already walked past *together with its position*, then "have I seen \`target - nums[j]\`?" becomes a single hash-map lookup.`,
    `Keep a hash map from value to index. For each \`j\` from left to right: look up \`target - nums[j]\`; if it is there with index \`i\`, return \`[i, j]\` — \`i\` is smaller because it was stored earlier. Otherwise store \`nums[j] → j\`. Look up *before* you store, so one position is never paired with itself; that is what makes \`nums = [3, 3]\`, \`target = 6\` work.`,
  ],
  editorial: `### Approach

The brute force checks every pair \`(i, j)\` with \`i < j\`. That is about n²/2 ≈ 5·10⁹ checks for the largest tests — far too slow.

Turn the question around. Standing at position \`j\`, you do not need to search for *a pair*; you need one specific value, \`need = target - nums[j]\`, somewhere to the left of \`j\`. A hash map from value to index answers "where did I see \`need\`?" in O(1) on average.

So scan once from left to right:

1. compute \`need = target - nums[j]\`;
2. if \`need\` is in the map at index \`i\`, the answer is \`[i, j]\` (already in increasing order, because \`i\` was stored earlier);
3. otherwise record \`nums[j] → j\` and move on.

Looking up before inserting is important: it stops a position from pairing with itself, while two *different* positions holding equal values (\`[3, 3]\`, \`target = 6\`) still work, because the first 3 is in the map when the second one arrives.

**Watch the range.** \`target\` can be ±2·10⁹, outside a 32-bit \`int\`, so \`target - nums[j]\` must be computed in 64 bits — that is why \`target\` is a \`long long\` in C++.

### Complexity

- Time: O(n) on average — one pass, O(1) per lookup and insert.
- Memory: O(n) for the map.

### C++

\`\`\`cpp
class Solution {
public:
    vector<int> twoSum(vector<int>& nums, long long target) {
        unordered_map<long long, int> seenAt;   // value -> index
        for (int j = 0; j < (int)nums.size(); ++j) {
            long long need = target - nums[j];
            auto it = seenAt.find(need);
            if (it != seenAt.end()) return {it->second, j};
            seenAt.emplace(nums[j], j);
        }
        return {};   // unreachable: every test has exactly one answer
    }
};
\`\`\`

### Python

\`\`\`python
class Solution:
    def twoSum(self, nums: List[int], target: int) -> List[int]:
        seen_at = {}                      # value -> index
        for j, value in enumerate(nums):
            i = seen_at.get(target - value)
            if i is not None:
                return [i, j]
            seen_at.setdefault(value, j)
        return []                         # unreachable
\`\`\`
`,
};
