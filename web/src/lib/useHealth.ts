import { useEffect, useState } from "react";
import { BASE_URL } from "../api/client";

export function useHealth() {
  const [online, setOnline] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    const check = () =>
      fetch(`${BASE_URL}/health`)
        .then((res) => {
          if (!cancelled) setOnline(res.ok);
        })
        .catch(() => {
          if (!cancelled) setOnline(false);
        });
    check();
    const id = setInterval(check, 15000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return online;
}
