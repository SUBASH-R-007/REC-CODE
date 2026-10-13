/**
 * The AuditLog hash-chain helpers now live in @recx/db (packages/db/src/
 * audit-chain.ts) so apps/scheduler can append to the chain too. This module
 * keeps the web app's import path stable.
 */
export {
  canonicalJson,
  chainDayOf,
  createChainVerifier,
  genesisHash,
  linkHash,
  verifyChain,
  type ChainEntry,
  type ChainRow,
  type ChainVerifier,
} from "@recx/db/audit-chain";
