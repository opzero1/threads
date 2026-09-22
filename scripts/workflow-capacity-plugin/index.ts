import plugin from "../../index";

export default {
  ...plugin,
  setup(context: Parameters<typeof plugin.setup>[0]) {
    return plugin.setup({ ...context, options: { ...context.options, maxWorkers: 8 } });
  },
};
