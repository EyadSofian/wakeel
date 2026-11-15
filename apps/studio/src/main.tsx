import "./styles.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ApiError } from "./api/client";
import { router } from "./router";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A problem from the api is an answer, not a blip: retrying a 403 or 404 only delays it.
      retry: (count, error) =>
        !(error instanceof ApiError && error.problem.status > 0 && error.problem.status < 500) && count < 2,
      refetchOnWindowFocus: false,
    },
  },
});

const root = document.getElementById("root");
if (!root) throw new Error("The page has no #root element.");
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
