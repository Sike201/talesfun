import { NextRequest } from "next/server";

const PINATA_JWT = process.env.PINATA_JWT!;
const PINATA_GATEWAY = "https://gateway.pinata.cloud/ipfs";

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();

    const image = formData.get("image") as File | null;
    const name = formData.get("name") as string;
    const symbol = formData.get("symbol") as string;
    const description = formData.get("description") as string;
    const twitter = formData.get("twitter") as string | null;
    const telegram = formData.get("telegram") as string | null;
    const website = formData.get("website") as string | null;

    if (!image || !name || !symbol || !description) {
      return Response.json(
        { error: "Missing required fields: image, name, symbol, description" },
        { status: 400 }
      );
    }

    // 1. Upload image to Pinata
    const imageFormData = new FormData();
    imageFormData.append("file", image);
    imageFormData.append(
      "pinataMetadata",
      JSON.stringify({ name: `${symbol}-image` })
    );

    const imageRes = await fetch(
      "https://api.pinata.cloud/pinning/pinFileToIPFS",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${PINATA_JWT}` },
        body: imageFormData,
      }
    );

    if (!imageRes.ok) {
      const err = await imageRes.text();
      return Response.json(
        { error: "Pinata image upload failed", details: err },
        { status: 502 }
      );
    }

    const imageData = await imageRes.json();
    const imageUri = `${PINATA_GATEWAY}/${imageData.IpfsHash}`;

    // 2. Build Metaplex-standard metadata JSON
    const metadata: Record<string, unknown> = {
      name,
      symbol,
      description,
      image: imageUri,
      properties: {
        files: [{ uri: imageUri, type: image.type }],
        category: "image",
      },
    };

    // Add optional social links as attributes
    const attributes: { trait_type: string; value: string }[] = [];
    if (twitter) attributes.push({ trait_type: "twitter", value: twitter });
    if (telegram) attributes.push({ trait_type: "telegram", value: telegram });
    if (website) attributes.push({ trait_type: "website", value: website });
    if (attributes.length > 0) metadata.attributes = attributes;

    // 3. Upload metadata JSON to Pinata
    const metadataRes = await fetch(
      "https://api.pinata.cloud/pinning/pinJSONToIPFS",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${PINATA_JWT}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          pinataContent: metadata,
          pinataMetadata: { name: `${symbol}-metadata` },
        }),
      }
    );

    if (!metadataRes.ok) {
      const err = await metadataRes.text();
      return Response.json(
        { error: "Pinata metadata upload failed", details: err },
        { status: 502 }
      );
    }

    const metadataData = await metadataRes.json();
    const metadataUri = `${PINATA_GATEWAY}/${metadataData.IpfsHash}`;

    return Response.json({ uri: metadataUri, imageUri });
  } catch (error) {
    return Response.json(
      { error: "Upload failed", details: String(error) },
      { status: 500 }
    );
  }
}
