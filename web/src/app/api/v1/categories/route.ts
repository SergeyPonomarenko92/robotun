import { NextResponse } from "next/server";
import { CATEGORY_TREE } from "../_mock/categories";

/**
 * GET /api/v1/categories — public 3-level active tree (Module 2 §4.6).
 *
 * Real backend caches with ETag (5-10 min). Mock returns the static tree
 * with childrenCount denormalized so the CategoryPicker side hint works.
 */
export async function GET() {
  const annotated = CATEGORY_TREE.map((l1) => ({
    ...l1,
    childrenCount: l1.children?.length ?? 0,
    children: l1.children?.map((l2) => ({
      ...l2,
      childrenCount: l2.children?.length ?? 0,
    })),
  }));
  return NextResponse.json(
    { items: annotated },
    {
      headers: {
        // Real backend ETags + 5-min CDN cache; mock just hints freshness.
        "Cache-Control": "public, max-age=60",
      },
    }
  );
}
