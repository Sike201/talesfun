import { NextRequest } from "next/server";

const PINATA_JWT = process.env.PINATA_JWT;
const PINATA_GATEWAY = "https://gateway.pinata.cloud/ipfs";

export async function POST(request: NextRequest) {
  try {
    if (!PINATA_JWT?.trim()) {
      console.error("[upload] PINATA_JWT is missing — set it in .env.local");
      return Response.json(
        { error: "Pinata is not configured (PINATA_JWT missing)" },
        { status: 503 }
      );
    }

    const formData = await request.formData();

    const image = formData.get("image") as File | null;
    const name = String(formData.get("name") ?? "").trim();
    const symbol = String(formData.get("symbol") ?? "").trim();
    const description = String(formData.get("description") ?? "").trim();
    const twitter = formData.get("twitter") as string | null;
    const telegram = formData.get("telegram") as string | null;
    const website = formData.get("website") as string | null;

    if (!name || !symbol || !description) {
      return Response.json(
        { error: "Missing required fields: name, symbol, description" },
        { status: 400 }
      );
    }

    const hasImage = image instanceof File && image.size > 0;

    let imageUri = "";

    if (hasImage) {
      // Pinata expects multipart field name "file" with a filename for many clients
      const imageFormData = new FormData();
      const filename =
        image.name && image.name.length > 0 ? image.name : "token-image.png";
      imageFormData.append("file", image, filename);
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
        console.error("[upload] pinFileToIPFS failed:", imageRes.status, err);
        return Response.json(
          { error: "Pinata image upload failed", details: err },
          { status: 502 }
        );
      }

      const imageData = (await imageRes.json()) as {
        IpfsHash?: string;
        cid?: string;
      };
      const imageCid = imageData.IpfsHash ?? imageData.cid;
      if (!imageCid) {
        return Response.json(
          { error: "Pinata image upload returned no CID", details: JSON.stringify(imageData) },
          { status: 502 }
        );
      }
      imageUri = `${PINATA_GATEWAY}/${imageCid}`;
    }

    // Metaplex-style metadata JSON (image optional — UI falls back to initials)
    const metadata: Record<string, unknown> = {
      name,
      symbol,
      description,
      ...(imageUri ? { image: imageUri } : { image: "" }),
      properties: hasImage
        ? {
            files: [{ uri: imageUri, type: image.type || "image/png" }],
            category: "image",
          }
        : { category: "image" },
    };

    const attributes: { trait_type: string; value: string }[] = [];
    if (twitter) attributes.push({ trait_type: "twitter", value: twitter });
    if (telegram) attributes.push({ trait_type: "telegram", value: telegram });
    if (website) attributes.push({ trait_type: "website", value: website });
    if (attributes.length > 0) metadata.attributes = attributes;

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
      console.error("[upload] pinJSONToIPFS failed:", metadataRes.status, err);
      return Response.json(
        { error: "Pinata metadata upload failed", details: err },
        { status: 502 }
      );
    }

    const metadataData = (await metadataRes.json()) as {
      IpfsHash?: string;
      cid?: string;
    };
    const metaCid = metadataData.IpfsHash ?? metadataData.cid;
    if (!metaCid) {
      return Response.json(
        { error: "Pinata metadata returned no CID", details: JSON.stringify(metadataData) },
        { status: 502 }
      );
    }
    const metadataUri = `${PINATA_GATEWAY}/${metaCid}`;

    return Response.json({ uri: metadataUri, imageUri: imageUri || null });
  } catch (error) {
    console.error("[upload]", error);
    return Response.json(
      { error: "Upload failed", details: String(error) },
      { status: 500 }
    );
  }
}
