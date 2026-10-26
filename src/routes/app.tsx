import { createFileRoute, redirect } from "@tanstack/react-router";

// The old Studio preview route depended on the platform's private UI kit.
// This independent build keeps the URL harmlessly routed back to the public site.
export const Route = createFileRoute("/app")({
  beforeLoad: () => {
    throw redirect({ to: "/" });
  },
});
