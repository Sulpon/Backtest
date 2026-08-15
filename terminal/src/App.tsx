import { ThemeProvider } from "./theme/ThemeProvider";
import { AppShell } from "./components/AppShell";

export default function App() {
  return (
    <ThemeProvider>
      <AppShell />
    </ThemeProvider>
  );
}
