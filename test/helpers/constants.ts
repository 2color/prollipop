import { encodeOptions } from "@ipld/dag-cbor";
import { MemoryBlockstore } from "blockstore-core";
import * as cbor from "cborg";
import { CID } from "multiformats/cid";
import { create as createMultihashDigest } from "multiformats/hashes/digest";
import { EncodedNode } from "../../src/codec.js";
import { DefaultBucket, DefaultNode } from "../../src/impls.js";
import {
  cborTreeCodec,
  sha256SyncHasher,
} from "../../src/codec.js";
import { Bucket, Prefix, Tuple } from "../../src/interface.js";
import { createProllyTree, createProllyTreeNodes } from "./create-tree.js";

// nodes
export const timestamp = 0;
export const hash = new Uint8Array(4); // isBoundaryHash expects Uint8Array with length >= 4
export const message = new Uint8Array(0);
export const node = new DefaultNode(timestamp, hash, message);
export const encodedNode: EncodedNode = [timestamp, hash, message];
export const nodeBytes = cbor.encode(encodedNode, encodeOptions);
export const nodeBytes2 = new Uint8Array([...nodeBytes, ...nodeBytes]);

// buckets
export type Mc = typeof cborTreeCodec.code;
export type Mh = typeof sha256SyncHasher.code;
export const prefix: Prefix<Mc, Mh> = {
  average: 30,
  mc: cborTreeCodec.code,
  mh: sha256SyncHasher.code,
  level: 0,
};
export const prefixBytes = cbor.encode(prefix, encodeOptions);
export const bucketBytes = new Uint8Array([...prefixBytes, ...nodeBytes]);
export const bucketHash = sha256SyncHasher.digest(bucketBytes).digest;
export const bucketCid = CID.createV1(
  cborTreeCodec.code,
  createMultihashDigest(sha256SyncHasher.code, bucketHash),
);
export const bucket: Bucket<Mc, Mh> = new DefaultBucket(
  prefix,
  [node],
  bucketBytes,
  bucketHash,
);
export const emptyBucket: Bucket<Mc, Mh> = new DefaultBucket(
  prefix,
  [],
  prefixBytes,
  sha256SyncHasher.digest(prefixBytes).digest,
);

export const blockstore = new MemoryBlockstore();

export const treeNodesMax = 64;

export const treeNodes = createProllyTreeNodes(
  Array(treeNodesMax)
    .fill(0)
    .map((_, i) => i),
  sha256SyncHasher,
);
export const treeTuples: Tuple[] = treeNodes.map(({ timestamp, hash }) => ({ timestamp, hash }))
export const [tree, treeState] = createProllyTree(
  blockstore,
  prefix,
  treeNodes,
  cborTreeCodec,
  sha256SyncHasher,
);
