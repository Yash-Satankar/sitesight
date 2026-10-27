import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import "./index.css";
import { Layout } from "./components/Layout";
import { ProjectsPage } from "./pages/Projects";
import { ProjectPage } from "./pages/Project";
import { BoqReviewPage } from "./pages/BoqReview";
import { CapturePage } from "./pages/Capture";
import { VisitPage } from "./pages/Visit";
import { ReviewPage } from "./pages/Review";
import { ReportPage } from "./pages/Report";

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: "/", element: <ProjectsPage /> },
      { path: "/projects/:projectId", element: <ProjectPage /> },
      { path: "/projects/:projectId/boq", element: <BoqReviewPage /> },
      { path: "/visits/:visitId", element: <VisitPage /> },
      { path: "/visits/:visitId/capture", element: <CapturePage /> },
      { path: "/visits/:visitId/review", element: <ReviewPage /> },
      { path: "/visits/:visitId/report", element: <ReportPage /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
