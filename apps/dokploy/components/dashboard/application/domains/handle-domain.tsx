import { zodResolver } from "@hookform/resolvers/zod";
import { DatabaseZap, Dices, RefreshCw } from "lucide-react";
import { useTranslation } from "next-i18next";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import z from "zod";
import { AlertBlock } from "@/components/shared/alert-block";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import {
	Form,
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input, NumberInput } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { api } from "@/utils/api";

export type CacheType = "fetch" | "cache";

export const domain = (t: (key: string, opts?: Record<string, unknown>) => string) =>
	z
		.object({
			host: z
				.string()
				.min(1, { message: t("application.domains.validation.hostRequired") })
				.refine((val) => val === val.trim(), {
					message: t(
						"application.domains.validation.hostNoLeadingTrailingSpaces",
					),
				})
				.transform((val) => val.trim()),
		path: z.string().min(1).optional(),
		internalPath: z.string().optional(),
		stripPath: z.boolean().optional(),
		port: z
			.number()
			.min(1, {
				message: t("application.domains.validation.portMin"),
			})
			.max(65535, {
				message: t("application.domains.validation.portMax"),
			})
			.optional(),
		https: z.boolean().optional(),
		certificateType: z.enum(["letsencrypt", "none", "custom"]).optional(),
		customCertResolver: z.string().optional(),
		serviceName: z.string().optional(),
		domainType: z.enum(["application", "compose", "preview"]).optional(),
		})
		.superRefine((input, ctx) => {
			if (input.https && !input.certificateType) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["certificateType"],
					message: t("application.domains.validation.required"),
				});
			}

			if (input.certificateType === "custom" && !input.customCertResolver) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["customCertResolver"],
					message: t("application.domains.validation.required"),
				});
			}

			if (input.domainType === "compose" && !input.serviceName) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["serviceName"],
					message: t("application.domains.validation.required"),
				});
			}

			// Validate stripPath requires a valid path
			if (input.stripPath && (!input.path || input.path === "/")) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["stripPath"],
					message: t(
						"application.domains.validation.stripPathWithValidPath",
					),
				});
			}

			// Validate internalPath starts with /
			if (
				input.internalPath &&
				input.internalPath !== "/" &&
				!input.internalPath.startsWith("/")
			) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["internalPath"],
					message: t(
						"application.domains.validation.internalPathStartsWithSlash",
					),
				});
			}
		});

type Domain = z.infer<typeof domain>;

interface Props {
	id: string;
	type: "application" | "compose";
	domainId?: string;
	children: React.ReactNode;
}

export const AddDomain = ({ id, type, domainId = "", children }: Props) => {
	const { t } = useTranslation("common");
	const [isOpen, setIsOpen] = useState(false);
	const [cacheType, setCacheType] = useState<CacheType>("cache");
	const [isManualInput, setIsManualInput] = useState(false);

	const utils = api.useUtils();
	const { data, refetch } = api.domain.one.useQuery(
		{
			domainId,
		},
		{
			enabled: !!domainId,
		},
	);

	const { data: application } =
		type === "application"
			? api.application.one.useQuery(
					{
						applicationId: id,
					},
					{
						enabled: !!id,
					},
				)
			: api.compose.one.useQuery(
					{
						composeId: id,
					},
					{
						enabled: !!id,
					},
				);

	const { mutateAsync, isError, error, isLoading } = domainId
		? api.domain.update.useMutation()
		: api.domain.create.useMutation();

	const { mutateAsync: generateDomain, isLoading: isLoadingGenerate } =
		api.domain.generateDomain.useMutation();

	const { data: canGenerateTraefikMeDomains } =
		api.domain.canGenerateTraefikMeDomains.useQuery({
			serverId: application?.serverId || "",
		});

	const {
		data: services,
		isFetching: isLoadingServices,
		error: errorServices,
		refetch: refetchServices,
	} = api.compose.loadServices.useQuery(
		{
			composeId: id,
			type: cacheType,
		},
		{
			retry: false,
			refetchOnWindowFocus: false,
			enabled: type === "compose" && !!id,
		},
	);

	const form = useForm<Domain>({
		resolver: zodResolver(domain),
		defaultValues: {
			host: "",
			path: undefined,
			internalPath: undefined,
			stripPath: false,
			port: undefined,
			https: false,
			certificateType: undefined,
			customCertResolver: undefined,
			serviceName: undefined,
			domainType: type,
		},
		mode: "onChange",
	});

	const certificateType = form.watch("certificateType");
	const https = form.watch("https");
	const domainType = form.watch("domainType");

	useEffect(() => {
		if (data) {
			form.reset({
				...data,
				/* Convert null to undefined */
				path: data?.path || undefined,
				internalPath: data?.internalPath || undefined,
				stripPath: data?.stripPath || false,
				port: data?.port || undefined,
				certificateType: data?.certificateType || undefined,
				customCertResolver: data?.customCertResolver || undefined,
				serviceName: data?.serviceName || undefined,
				domainType: data?.domainType || type,
			});
		}

		if (!domainId) {
			form.reset({
				host: "",
				path: undefined,
				internalPath: undefined,
				stripPath: false,
				port: undefined,
				https: false,
				certificateType: undefined,
				customCertResolver: undefined,
				domainType: type,
			});
		}
	}, [form, data, isLoading, domainId]);

	// Separate effect for handling custom cert resolver validation
	useEffect(() => {
		if (certificateType === "custom") {
			form.trigger("customCertResolver");
		}
	}, [certificateType, form]);

	const dictionary = {
		success: domainId
			? t("application.domains.handle.toast.update.success")
			: t("application.domains.handle.toast.create.success"),
		error: domainId
			? t("application.domains.handle.toast.update.error")
			: t("application.domains.handle.toast.create.error"),
		submit: domainId
			? t("application.domains.handle.button.update")
			: t("application.domains.handle.button.create"),
		dialogDescription: domainId
			? t("application.domains.handle.dialog.edit.description")
			: t("application.domains.handle.dialog.create.description"),
	};

	const onSubmit = async (data: Domain) => {
		await mutateAsync({
			domainId,
			...(data.domainType === "application" && {
				applicationId: id,
			}),
			...(data.domainType === "compose" && {
				composeId: id,
			}),
			...data,
		})
			.then(async () => {
				toast.success(dictionary.success);

				if (data.domainType === "application") {
					await utils.domain.byApplicationId.invalidate({
						applicationId: id,
					});
					await utils.application.readTraefikConfig.invalidate({
						applicationId: id,
					});
				} else if (data.domainType === "compose") {
					await utils.domain.byComposeId.invalidate({
						composeId: id,
					});
				}

				if (domainId) {
					refetch();
				}
				setIsOpen(false);
			})
			.catch((e) => {
				console.log(e);
				toast.error(dictionary.error);
			});
	};
	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			<DialogTrigger className="" asChild>
				{children}
			</DialogTrigger>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>
						{t("application.domains.handle.dialog.title")}
					</DialogTitle>
					<DialogDescription>{dictionary.dialogDescription}</DialogDescription>
				</DialogHeader>
				{isError && <AlertBlock type="error">{error?.message}</AlertBlock>}

				{type === "compose" && (
					<AlertBlock type="info" className="mb-4">
						Whenever you make changes to domains, remember to redeploy your
						compose to apply the changes.
					</AlertBlock>
				)}

				<Form {...form}>
					<form
						id="hook-form"
						onSubmit={form.handleSubmit(onSubmit)}
																/>
															</FormControl>
															<FormMessage />
														</FormItem>
													);
												}}
											/>
										)}
									</>
								)}
							</div>
						</div>
					</form>

					<DialogFooter>
						<Button isLoading={isLoading} form="hook-form" type="submit">
							{dictionary.submit}
						</Button>
					</DialogFooter>
				</Form>
			</DialogContent>
		</Dialog>
	);
};
