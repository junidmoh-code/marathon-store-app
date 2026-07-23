// Logic for the Missing Prices admin card — testable, pure.

export const needsCost = (p) => p.stockPrice == null || p.stockPrice === "" || p.stockPrice === 0;
export const needsRetail = (p) => p.retailPrice == null || p.retailPrice === "" || p.retailPrice === 0;
export const needsAny = (p) => needsCost(p) || needsRetail(p);

export const typeOf = (p) => {
  if (p.productType === "clothing") return "clothing";
  if (p.productType === "sneaker") return "shoes";
  const cat = (p.category || "").toLowerCase();
  if (/accessor|belt|watch|glass|necklace|bracelet/.test(cat)) return "accessories";
  if (/perfume|fragrance|cologne/.test(cat)) return "perfumes";
  return "other";
};

export const createdAt = (p) => {
  const m = /^p(\d+)$/.exec(p.id || "");
  return m ? Number(m[1]) : 0;
};

export const updatedAt = (p) => p.photoUpdatedAt || createdAt(p);

function parseDrafts(costDraft, retailDraft) {
  const costTrim = String(costDraft).trim();
  const retailTrim = String(retailDraft).trim();
  return {
    costNum: costTrim ? Number(costTrim) : null,
    retailNum: retailTrim ? Number(retailTrim) : null,
  };
}

export function buildUpdates(editProduct, costDraft, retailDraft) {
  const updates = {};
  const { costNum, retailNum } = parseDrafts(costDraft, retailDraft);

  if (needsCost(editProduct) && costNum != null && Number.isFinite(costNum) && costNum > 0) {
    updates.stockPrice = costNum;
  }
  if (needsRetail(editProduct) && retailNum != null && Number.isFinite(retailNum) && retailNum > 0) {
    updates.retailPrice = retailNum;
  }
  return updates;
}

export function validatePrices(editProduct, costDraft, retailDraft) {
  const { costNum, retailNum } = parseDrafts(costDraft, retailDraft);

  if (needsCost(editProduct) && (costNum == null || !Number.isFinite(costNum) || costNum <= 0)) {
    return { ok: false, error: "Enter a valid Stock Price greater than 0." };
  }
  if (needsRetail(editProduct) && (retailNum == null || !Number.isFinite(retailNum) || retailNum <= 0)) {
    return { ok: false, error: "Enter a valid Retail Price greater than 0." };
  }
  if (retailNum != null && costNum != null && retailNum < costNum) {
    return { ok: false, needsConfirm: true, error: `Retail Price (R${retailNum}) is lower than Stock Price (R${costNum}). Continue?` };
  }
  return { ok: true };
}
