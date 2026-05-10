import { NextResponse } from "next/server";
import { findListing, projectListingDetail } from "../../_mock/listings";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const base = findListing(id);
  if (!base) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json(projectListingDetail(base));
}
