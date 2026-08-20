import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import App from "./App";
afterEach(cleanup);
beforeEach(()=>history.replaceState({},'',location.pathname+'?scenario=mock'));
describe("Phase 0 interactions", () => {
  it("filters and searches routes locally", async () => {
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Proxy Routes" }));
    await userEvent.click(screen.getByRole("button", { name: "External" }));
    expect(screen.getByText("legacy.example.com")).toBeInTheDocument();
    expect(screen.queryByText("grafana.example.com")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "All" }));
    await userEvent.type(screen.getByRole("searchbox"), "api.example");
    expect(screen.getByText("api.example.com")).toBeInTheDocument();
  });
  it("dashboard View All Routes works and attention excludes healthy routes", async () => {
    render(<App />);
    const attention = screen.getByRole("region", { name: "Needs Attention" });
    expect(
      within(attention).queryByText("grafana.example.com"),
    ).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "View All Routes" }),
    );
    expect(
      screen.getByRole("heading", { name: "Proxy Routes" }),
    ).toBeInTheDocument();
  });
  it("validates reactively and disables submit while invalid", async () => {
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Proxy Routes" }));
    await userEvent.click(screen.getByRole("button", { name: "Add route" }));
    const save = screen.getByRole("button", { name: "Save route" });
    expect(save).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Domain"), "bad");
    expect(
      screen.getByText("Enter a valid fully qualified domain"),
    ).toBeInTheDocument();
  });
  it("closes modal with Escape", async () => {
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Proxy Routes" }));
    await userEvent.click(screen.getByRole("button", { name: "Add route" }));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("delete offers managed DNS removal", async () => {
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Proxy Routes" }));
    await userEvent.click(screen.getByLabelText("Delete grafana.example.com"));
    expect(
      screen.getByLabelText("Remove managed DNS record"),
    ).toBeInTheDocument();
  });
  it("external DNS actions are unavailable", async () => {
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "DNS Records" }));
    const row = screen.getByText("legacy.example.com").closest("tr")!;
    expect(within(row).getByText("Unavailable")).toBeInTheDocument();
  });
  it("filters DNS records by name and type, then exposes copy actions", async () => {
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "DNS Records" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "Search DNS records" }), "grafana");
    expect(screen.getByText("grafana.example.com")).toBeInTheDocument();
    expect(screen.queryByText("legacy.example.com")).not.toBeInTheDocument();
    await userEvent.clear(screen.getByRole("searchbox", { name: "Search DNS records" }));
    await userEvent.selectOptions(screen.getByLabelText("Record type"), "CNAME");
    expect(screen.getByText("legacy.example.com")).toBeInTheDocument();
    expect(screen.queryByText("grafana.example.com")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Copy DNS value for legacy.example.com")).toBeInTheDocument();
  });
  it("keeps external connection labels paired with values and hides absent targets", async () => {
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Proxy Routes" }));
    await userEvent.click(screen.getByRole("button", { name: "View legacy.example.com" }));

    const details = screen.getByRole("group", { name: "Connection Information" });
    const fields = within(details).getAllByTestId("connection-field");
    expect(fields).toHaveLength(14);
    for (const field of fields) {
      expect(field.querySelector("dt")).toBeTruthy();
      expect(field.querySelector("dd")).toBeTruthy();
    }
    expect(within(details).getByText("Backend URL").nextElementSibling).toHaveTextContent("Not available");
    expect(details).not.toHaveTextContent("://:0");
  });
});
