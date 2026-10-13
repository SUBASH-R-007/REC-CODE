/**
 * The closed 14-topic taxonomy. Problem tags, the profile skill radar, the
 * readiness topicBreadth MIN, and the placement weakness heatmap all key off
 * this list. It is the only definition in the repository.
 *
 * The prompt fixes the count (14) but not the members; the choice below is
 * recorded in docs/OPEN-QUESTIONS.md for the placement cell to confirm.
 */
export const TOPICS = [
  "ARRAYS_HASHING",
  "TWO_POINTERS",
  "SLIDING_WINDOW",
  "STACK_QUEUE",
  "BINARY_SEARCH",
  "LINKED_LIST",
  "TREES",
  "HEAPS",
  "BACKTRACKING",
  "GRAPHS",
  "DYNAMIC_PROGRAMMING",
  "GREEDY",
  "MATH_BITS",
  "STRINGS",
] as const;

export type Topic = (typeof TOPICS)[number];

export const TOPIC_LABEL: Readonly<Record<Topic, string>> = {
  ARRAYS_HASHING: "Arrays & Hashing",
  TWO_POINTERS: "Two Pointers",
  SLIDING_WINDOW: "Sliding Window",
  STACK_QUEUE: "Stacks & Queues",
  BINARY_SEARCH: "Binary Search",
  LINKED_LIST: "Linked Lists",
  TREES: "Trees",
  HEAPS: "Heaps & Priority Queues",
  BACKTRACKING: "Recursion & Backtracking",
  GRAPHS: "Graphs",
  DYNAMIC_PROGRAMMING: "Dynamic Programming",
  GREEDY: "Greedy",
  MATH_BITS: "Math & Bit Manipulation",
  STRINGS: "Strings",
};

export function isTopic(value: unknown): value is Topic {
  return typeof value === "string" && (TOPICS as readonly string[]).includes(value);
}
