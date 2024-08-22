import { firstElement, ithElement, lastElement } from "@tabcat/ith-element";
import type { Blockstore } from "interface-blockstore";
import { CID, SyncMultihashHasher } from "multiformats";
import { compare } from "uint8arrays";
import { TreeCodec } from "./codec.js";
import { compareTuples } from "./compare.js";
import { Bucket, Node, ProllyTree, Tuple } from "./interface.js";
import {
  createNamedErrorClass,
  findFailureOrLastIndex,
  prefixWithLevel,
} from "./internal.js";
import { loadBucket } from "./utils.js";

export const CursorError = createNamedErrorClass("CursorError");
export const CursorLockError = createNamedErrorClass("CursorLockError");

const failedToAquireLockErr = () =>
  new CursorLockError("Failed to aquire cursor lock.");

export interface CursorState<Code extends number, Alg extends number> {
  blockstore: Blockstore;
  codec: TreeCodec<Code>;
  hasher: SyncMultihashHasher<Alg>;
  currentBuckets: Bucket<Code, Alg>[];
  currentIndex: number;
  isDone: boolean;
  isLocked: boolean;
}

const FailedToCreateCursorState = "Failed to create cursor state: ";

export const createCursorState = <Code extends number, Alg extends number>(
  blockstore: Blockstore,
  tree: ProllyTree<Code, Alg>,
  currentBuckets?: Bucket<Code, Alg>[],
  currentIndex?: number,
): CursorState<Code, Alg> => {
  currentBuckets = currentBuckets ?? [tree.root];
  currentIndex =
    currentIndex ?? Math.min(0, lastElement(currentBuckets).nodes.length - 1);

  if (currentBuckets.length === 0) {
    throw new CursorError(
      `${FailedToCreateCursorState}currentBuckets.length === 0`,
    );
  }

  if (currentIndex >= lastElement(currentBuckets).nodes.length) {
    throw new CursorError(
      `${FailedToCreateCursorState}currentIndex >= bucket.nodes.length`,
    );
  }

  if (currentIndex < -1) {
    throw new CursorError(`${FailedToCreateCursorState}currentIndex > -1`);
  }

  return {
    blockstore,
    codec: tree.getCodec(),
    hasher: tree.getHasher(),
    currentBuckets,
    currentIndex,
    isDone: currentIndex === -1,
    isLocked: false,
  };
};

export interface Cursor<Code extends number, Alg extends number> {
  /**
   * Returns the current level of the cursor.
   */
  level(): number;
  /**
   * Returns the root level of the tree.
   */
  rootLevel(): number;

  /**
   * Returns the index of the current node in the bucket. If index is -1 the bucket is empty and current() will throw an error.
   */
  index(): number;
  /**
   * Returns the current node in the bucket. If the bucket is empty this method will throw an error.
   */
  current(): Node;

  /**
   * Returns an array of buckets from root to current level.
   */
  buckets(): Bucket<Code, Alg>[];
  /**
   * Returns an array of bucket CIDs from root to current level.
   */
  path(): CID[];
  /**
   * Returns the current bucket. The last bucket in the array returned by the buckets() method.
   */
  currentBucket(): Bucket<Code, Alg>;

  /**
   * Increments the cursor to the next tuple on the current level.
   */
  next(): Promise<void>;
  /**
   * Increments the cursor to the next tuple on a specified level.
   *
   * @param level - The level to increment the cursor at.
   */
  nextAtLevel(level: number): Promise<void>;
  /**
   * Increments the cursor to the beginning of the next bucket on the current level.
   */
  nextBucket(): Promise<void>;
  /**
   * Increments the cursor to the beginning of the next bucket on the specified level.

   * @param level - The level to increment the cursor at.
   */
  nextBucketAtLevel(level: number): Promise<void>;
  /**
   * Fast forwards the cursor to
   *
   * @param tuple
   * @param level
   */
  ffw(tuple: Tuple, level: number): Promise<void>;

  /**
   * Returns true or false depending on whether the cursor is at the tail bucket for the level.
   */
  isAtTail(): boolean;
  /**
   * Returns true or false depending on whether the cursor is at the head bucket for the level.
   */
  isAtHead(): boolean;

  /**
   * Returns true or false depending on whether the cursor is currently being incremented.
   */
  locked(): boolean;
  /**
   * Returns true or false depending on whether the cursor has reached the end of the tree.
   */
  done(): boolean;

  /**
   * Returns a clone of the cursor instance.
   */
  clone(): Cursor<Code, Alg>;
}

export function createCursorFromState<Code extends number, Alg extends number>(
  state: CursorState<Code, Alg>,
): Cursor<Code, Alg> {
  return {
    level: () => levelOf(state),
    rootLevel: () => rootLevelOf(state),

    index: () => state.currentIndex,
    current: () => nodeOf(state),

    buckets: () => Array.from(state.currentBuckets),
    path: () => state.currentBuckets.map((b) => b.getCID()),
    currentBucket: () => bucketOf(state),

    next: () => nextAtLevel(state, levelOf(state)),
    nextAtLevel: (level) => nextAtLevel(state, level),
    nextBucket: () => nextBucketAtLevel(state, levelOf(state)),
    nextBucketAtLevel: (level) => nextBucketAtLevel(state, level),
    ffw: (tuple, level) => ffwToTupleOnLevel(state, tuple, level),

    isAtTail: () => getIsAtTail(state),
    isAtHead: () => getIsAtHead(state),

    clone: () => createCursorFromState(cloneCursorState(state)),

    locked: () => state.isLocked,
    done: () => state.isDone,
  };
}

export function createCursor<Code extends number, Alg extends number>(
  blockstore: Blockstore,
  tree: ProllyTree<Code, Alg>,
): Cursor<Code, Alg> {
  const state = createCursorState(blockstore, tree);
  return createCursorFromState(state);
}

export const cloneCursorState = <Code extends number, Alg extends number>(
  state: CursorState<Code, Alg>,
): CursorState<Code, Alg> => ({
  ...state,
  currentBuckets: Array.from(state.currentBuckets),
});

export const bucketOf = <Code extends number, Alg extends number>(
  state: CursorState<Code, Alg>,
): Bucket<Code, Alg> => lastElement(state.currentBuckets);

export const nodeOf = <Code extends number, Alg extends number>(
  state: CursorState<Code, Alg>,
): Node => ithElement(bucketOf(state).nodes, state.currentIndex);

export const levelOf = <Code extends number, Alg extends number>(
  state: CursorState<Code, Alg>,
): number => bucketOf(state).prefix.level;

export const rootLevelOf = <Code extends number, Alg extends number>(
  state: CursorState<Code, Alg>,
): number => firstElement(state.currentBuckets).prefix.level;

export const getIsExtremity = <Code extends number, Alg extends number>(
  state: CursorState<Code, Alg>,
  findExtemity: (nodes: Node[]) => Node,
): boolean => {
  let i = 0;

  // length - 1 because we are accessing i + 1
  while (i < state.currentBuckets.length - 1) {
    const parent = ithElement(state.currentBuckets, i);
    const child = ithElement(state.currentBuckets, i + 1);

    // check if the extreme node of the parent matches the current child all the way down from root
    if (compare(findExtemity(parent.nodes).message, child.getHash()) !== 0) {
      return false;
    }

    i++;
  }

  return true;
};

export const getIsAtTail = <Code extends number, Alg extends number>(
  state: CursorState<Code, Alg>,
): boolean => getIsExtremity(state, firstElement);
export const getIsAtHead = <Code extends number, Alg extends number>(
  state: CursorState<Code, Alg>,
): boolean => getIsExtremity(state, lastElement);

/**
 * Returns whether increasing the currentIndex will overflow the bucket.
 *
 * @param state - the state of the cursor
 * @returns
 */
const overflows = <Code extends number, Alg extends number>(
  state: CursorState<Code, Alg>,
): boolean =>
  state.currentIndex === lastElement(state.currentBuckets).nodes.length - 1;

export const guideByTuple =
  (target: Tuple) =>
  (nodes: Node[]): number =>
    findFailureOrLastIndex(nodes, (n) => compareTuples(target, n) > 0);

// when descending it is important to keep to the left side
// otherwise nodes are skipped
export const guideByLowestIndex = () => 0;

/**
 * Moves the cursor vertically. Never causes the cursor to increment without a provided _guide parameter.
 * 
 * @param state 
 * @param level 
 * @param _guide 
 */
export const moveToLevel = async <Code extends number, Alg extends number>(
  state: CursorState<Code, Alg>,
  level: number,
  _guide?: (nodes: Node[]) => number,
): Promise<void> => {
  if (level === levelOf(state)) {
    throw new CursorError("Level to move to cannot be same as current level.");
  }

  if (level < 0) {
    throw new CursorError("Level to move to cannot be less than 0.");
  }

  if (level > rootLevelOf(state)) {
    throw new CursorError(
      "Level to move to cannot exceed height of root level.",
    );
  }

  // guides currentIndex during traversal
  const guide: (nodes: Node[]) => number =
    _guide ??
    // 0 index when descending, current tuple when ascending
    (level < levelOf(state) ? guideByLowestIndex : guideByTuple(nodeOf(state)));

  while (level !== levelOf(state)) {
    if (level > levelOf(state)) {
      // jump up to higher level
      const difference = levelOf(state) - level;

      state.currentBuckets.splice(difference, -difference);
    } else {
      // walk down to lower level
      const digest = nodeOf(state).message;
      const bucket = await loadBucket(
        state.blockstore,
        digest,
        prefixWithLevel(bucketOf(state).prefix, levelOf(state) - 1),
        state.codec,
        state.hasher,
      );

      if (bucket.nodes.length === 0) {
        throw new CursorError(
          "Malformed tree: fetched a child bucket with empty node set.",
        );
      }

      state.currentBuckets.push(bucket);
    }

    // set to guided index
    state.currentIndex = guide(bucketOf(state).nodes);
  }
};

/**
 * Increments the cursor by one on the same level. Handles traversing buckets if necessary.
 * 
 * @param state 
 * @returns 
 */
export const moveSideways = async <Code extends number, Alg extends number>(
  state: CursorState<Code, Alg>,
): Promise<void> => {
  const stateCopy = cloneCursorState(state)

  // find a higher level which allows increasing currentIndex
  while (overflows(stateCopy)) {
    // cannot increase currentIndex anymore, so done
    if (stateCopy.currentBuckets.length === 1) {
      state.isDone = true;
      return;
    }

    await moveToLevel(stateCopy, levelOf(stateCopy) + 1);
  }

  stateCopy.currentIndex += 1;

  // get back down to same level
  while (levelOf(stateCopy) !== levelOf(state)) {
    await moveToLevel(stateCopy, levelOf(state));
  }

  Object.assign(state, stateCopy);
};

export const nextAtLevel = async <Code extends number, Alg extends number>(
  state: CursorState<Code, Alg>,
  level: number,
): Promise<void> => {
  if (level > rootLevelOf(state)) {
    state.isDone = true;
  }

  if (state.isDone) {
    return;
  }

  if (state.isLocked) {
    throw failedToAquireLockErr();
  }

  const stateCopy = cloneCursorState(state);
  state.isLocked = true;

  if (level !== levelOf(stateCopy)) {
    await moveToLevel(stateCopy, level);
  }

  // only increment if level was higher or equal to original level
  if (level >= levelOf(state)) {
    await moveSideways(stateCopy);
  }

  Object.assign(state, stateCopy);
};

const nextBucketAtLevel = async <Code extends number, Alg extends number>(
  state: CursorState<Code, Alg>,
  level: number,
): Promise<void> => {
  if (level > rootLevelOf(state)) {
    state.isDone = true;
  }

  if (state.isDone) {
    return;
  }

  if (state.isLocked) {
    throw failedToAquireLockErr();
  }

  const stateCopy = cloneCursorState(state);
  state.isLocked = true;

  if (level !== levelOf(state)) {
    await moveToLevel(stateCopy, level);
  }

  stateCopy.currentIndex = bucketOf(state).nodes.length - 1;

  await moveSideways(stateCopy);

  Object.assign(state, stateCopy);
};

const ffwToTupleOnLevel = async <Code extends number, Alg extends number>(
  state: CursorState<Code, Alg>,
  tuple: Tuple,
  level: number,
): Promise<void> => {
  if (level > rootLevelOf(state)) {
    state.isDone = true;
  }

  if (state.isDone) {
    return;
  }

  if (state.isLocked) {
    throw failedToAquireLockErr();
  }

  const stateCopy = cloneCursorState(state);
  state.isLocked = true;

  // move up until finding a node greater than tuple
  // could be sped up by checking currentBuckets directly
  while (
    levelOf(state) < rootLevelOf(state) &&
    compareTuples(tuple, lastElement(bucketOf(state).nodes)) > 0
  ) {
    await moveToLevel(state, levelOf(state) + 1, guideByTuple(tuple));
  }

  // move to level targeting tuple
  if (level !== levelOf(state)) {
    await moveToLevel(state, level, guideByTuple(tuple));
  }

  // could not find a node greater than or equal to tuple
  if (compareTuples(tuple, nodeOf(state)) > 0) {
    stateCopy.isDone;
  }

  Object.assign(state, stateCopy);
};
