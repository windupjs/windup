import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/posts/$postId")({
  component: () => <article data-testid="post">Post</article>,
});
