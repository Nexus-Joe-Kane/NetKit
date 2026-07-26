const definitions = {
  xhamster: {
    url: "https://xhamster.com/videos/fixture-video-abc123",
    thumb: "https://ic-vt-nss.xhcdn.com/fixture.jpg",
    uploaderUrl: "https://xhamster.com/users/fixture-creator/videos",
    uploaderId: "xhamster:creator:fixture-creator",
  },
  xvideos: {
    url: "https://www.xvideos.com/video.fixture/fixture-video",
    thumb: "https://thumb-cdn77.xvideos-cdn.com/fixture.jpg",
    uploaderUrl: "https://www.xvideos.com/fixture-creator",
    uploaderId: "xvideos:fixture-creator",
  },
  pornhub: {
    url: "https://www.pornhub.com/view_video.php?viewkey=fixture",
    thumb: "https://pix-cdn77.phncdn.com/fixture.jpg",
    uploaderUrl: "https://www.pornhub.com/channels/fixture-creator",
    uploaderId: "pornhub:channels:fixture-creator",
  },
  eporner: {
    url: "https://www.eporner.com/hd-porn/fixture/fixture-video/",
    thumb: "https://static-eu-cdn.eporner.com/fixture.jpg",
    uploaderUrl: "https://www.eporner.com/profile/fixture-creator/",
    uploaderId: "eporner:fixture-creator",
  },
} as const;

export function upstreamFixture(channel: keyof typeof definitions) {
  const definition = definitions[channel];
  return {
    pageInfo: { hasNextPage: true },
    items: [
      {
        id: `${channel}-fixture`,
        title: `${channel} public fixture`,
        url: definition.url,
        duration: 125,
        channel,
        thumb: definition.thumb,
        views: 1_200,
        uploader: "Fixture Creator",
        uploaderUrl: definition.uploaderUrl,
        uploaderId: definition.uploaderId,
        verified: true,
        isLive: false,
      },
    ],
  };
}

export function upstreamFetch(): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.hostname !== "hottub.spacemoehre.de") {
      throw new Error(`Unexpected host: ${url.hostname}`);
    }
    const payload = JSON.parse(String(init?.body ?? "{}")) as { channel?: string };
    if (!payload.channel || !(payload.channel in definitions)) {
      return new Response(JSON.stringify({ pageInfo: { hasNextPage: false }, items: [] }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify(upstreamFixture(payload.channel as keyof typeof definitions)),
      { headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
}
