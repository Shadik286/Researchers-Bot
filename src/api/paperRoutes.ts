import { HttpError } from "../http/HttpError.js";
import { buildPaperId } from "../models/Paper.js";
import { deriveFullText } from "../sources/BaseSource.js";
import { parseJsonBody, validatePaperId, validateSearchRequest } from "../security/InputValidator.js";
import { readBody } from "./readBody.js";
import type { RequestContext, Router } from "./routes.js";
import { sendError, sendJson } from "./routes.js";

/**
 * Paper endpoints.
 *
 *   POST /api/papers/search   the main discovery pipeline
 *   GET  /api/papers/:id      direct lookup by a scheme-prefixed identifier
 */

export function registerPaperRoutes(router: Router): void {
  router.post("/api/papers/search", handleSearch);
  router.get("/api/papers/:id", handleGetPaper);
}

async function handleSearch(ctx: RequestContext): Promise<void> {
  const { config, orchestrator } = ctx.deps;

  const raw = await readBody(ctx.req, config.server.maxBodyBytes);
  const parsed = parseJsonBody(raw);
  const query = validateSearchRequest(parsed); // throws ValidationError -> 400

  ctx.logger.info("search_request_received", {
    requestId: ctx.requestId,
    hasDoi: Boolean(query.doi),
    hasTitle: Boolean(query.title),
    authorCount: query.authors?.length ?? 0,
    keywordCount: query.keywords?.length ?? 0,
  });

  try {
    const response = await orchestrator.findPaper(query, ctx.signal);

    // Attach the canonical id so a client can call GET /api/papers/:id later.
    const body = {
      ...response,
      exactPaper: response.exactPaper
        ? { ...response.exactPaper, id: buildPaperId(response.exactPaper) }
        : null,
      similarPapers: response.similarPapers.map((paper) => ({ ...paper, id: buildPaperId(paper) })),
    };

    sendJson(ctx.res, 200, body, ctx.requestId);
  } catch (error) {
    if (error instanceof HttpError && error.kind === "aborted") {
      // The client went away; nothing to send.
      ctx.logger.debug("search_request_cancelled", { requestId: ctx.requestId });
      return;
    }
    if (error instanceof HttpError && error.isRateLimited) {
      sendError(
        ctx.res,
        {
          status: 429,
          code: "UPSTREAM_RATE_LIMITED",
          message: "Academic sources are rate limiting this service. Please retry shortly.",
          retryAfterSeconds: error.retryAfterMs ? error.retryAfterMs / 1000 : 30,
        },
        ctx.requestId,
      );
      return;
    }
    throw error;
  }
}

async function handleGetPaper(ctx: RequestContext): Promise<void> {
  const { orchestrator } = ctx.deps;

  const id = ctx.params.id ?? "";
  const { scheme, value } = validatePaperId(id); // throws ValidationError -> 400

  const paper = await orchestrator.lookupById(scheme, value, ctx.signal);

  if (!paper) {
    sendError(
      ctx.res,
      {
        status: 404,
        code: "PAPER_NOT_FOUND",
        message: `No paper matching "${scheme}:${value}" was found in the configured academic sources.`,
      },
      ctx.requestId,
    );
    return;
  }

  sendJson(
    ctx.res,
    200,
    {
      success: true,
      paper: { ...paper, id: buildPaperId(paper) },
      fullText: deriveFullText(paper),
    },
    ctx.requestId,
  );
}
