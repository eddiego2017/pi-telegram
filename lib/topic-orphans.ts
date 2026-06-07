/**
 * Telegram forum-topic orphan proof store
 * Zones: telegram diagnostics, forum topics, shared utils
 * Tracks conservative Bot API missing-topic proofs for repair commands without coupling API transport to workspace records.
 */

export interface TelegramTopicOrphanProof {
  chatId: number;
  messageThreadId: number;
  method: string;
  message: string;
  at: number;
}

export interface TelegramTopicOrphanProofStore {
  record: (proof: TelegramTopicOrphanProof) => void;
  getProofs: () => TelegramTopicOrphanProof[];
  clearProofsFor: (chatId: number, messageThreadId: number) => number;
}

function getTelegramTopicOrphanProofKey(
  chatId: number,
  messageThreadId: number,
): string {
  return `${chatId}:${messageThreadId}`;
}

export function isSameTelegramTopicOrphanTarget(
  proof: Pick<TelegramTopicOrphanProof, "chatId" | "messageThreadId">,
  target: { chatId: number; messageThreadId?: number },
): boolean {
  return (
    proof.chatId === target.chatId &&
    proof.messageThreadId === target.messageThreadId
  );
}

export function createTelegramTopicOrphanProofStore(
  maxProofs = 100,
): TelegramTopicOrphanProofStore {
  const proofs = new Map<string, TelegramTopicOrphanProof>();
  const prune = (): void => {
    while (proofs.size > maxProofs) {
      const oldest = [...proofs.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!oldest) return;
      proofs.delete(oldest[0]);
    }
  };
  return {
    record: (proof) => {
      proofs.set(
        getTelegramTopicOrphanProofKey(proof.chatId, proof.messageThreadId),
        proof,
      );
      prune();
    },
    getProofs: () => [...proofs.values()].sort((a, b) => a.at - b.at),
    clearProofsFor: (chatId, messageThreadId) => {
      const key = getTelegramTopicOrphanProofKey(chatId, messageThreadId);
      const existed = proofs.delete(key);
      return existed ? 1 : 0;
    },
  };
}
