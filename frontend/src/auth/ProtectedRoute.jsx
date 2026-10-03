import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "./useAuth";

/** Unauthenticated users never reach protected pages; session is
 * reconstructed from the backend (cookie refresh) on every full load. */
export default function ProtectedRoute({ children }) {
  const { status } = useAuth();
  const location = useLocation();
  if (status === "loading") {
    return (
      <div className="app-page">
        <div className="page-container">
          <p className="status-line" role="status" aria-live="polite">
            Restoring your session…
          </p>
        </div>
      </div>
    );
  }
  if (status !== "authenticated") {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return children;
}
