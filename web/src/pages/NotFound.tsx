import { Link } from "react-router-dom";
import { Compass, ArrowRight } from "lucide-react";

export function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-50 px-6 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-50 text-brand-600">
        <Compass className="h-7 w-7" />
      </div>
      <div className="mt-6 text-sm font-bold uppercase tracking-wide text-slate-400">404</div>
      <h1 className="mt-2 text-2xl font-bold text-slate-900">This sandbox doesn't have that page</h1>
      <p className="mt-2 max-w-sm text-sm text-slate-500">
        Nothing here — real or synthetic. Head back to the console or the homepage.
      </p>
      <div className="mt-6 flex gap-3">
        <Link to="/console" className="fb-btn-primary">
          Open Console <ArrowRight className="h-4 w-4" />
        </Link>
        <Link to="/" className="fb-btn-secondary">
          Homepage
        </Link>
      </div>
    </div>
  );
}
