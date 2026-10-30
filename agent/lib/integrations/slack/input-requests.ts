import type { SlackRenderer } from "eve/channels/slack";

/**
 * Optional presentation override for Slack interactions.
 *
 * @remarks eve owns interaction routing, button identifiers, delivery, and
 * updates. The renderer can only restyle the cards it receives.
 */
export type SlackInputRequestsConfig = Pick<SlackRenderer, "interactionCard">;
