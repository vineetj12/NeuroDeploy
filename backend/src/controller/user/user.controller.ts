import { prisma } from "../../PrismaClientManager/index.ts";

export const CreateUser = async (email: string, password: string) => {
    try {
        return await prisma.user.create({
            data: {
                email,
                password,
            },
        });
    } catch (error) {
        console.error("Error creating user:", error);
        throw error;
    }
};


export const UpdateUser = async (
    id: string,
    data: {
        email?: string;
        password?: string;
        selectedModelId?: string | null;
    }
) => {
    return prisma.user.update({
        where: { id },
        data,
    });
};
export const CheckUserAndPassword = async (email: string, password: string) => {
    return await prisma.user.findUnique({
        where: { email, password },
    });
}
export const AddUserCredential = async (userId: string, modelId: string, apiKey: string) => {
    if (!userId || !modelId || !apiKey) {
        throw new Error("Missing required fields");
    }
    return await prisma.userModelKey.create({
        data: {
            userId,
            modelId,
            apiKey,
        },
    });
}

export const UpdateUserModelKey = async (
    userId: string,
    modelId: string,
    apiKey: string
) => {
    return await prisma.userModelKey.update({
        where: { userId_modelId: { userId, modelId } },
        data: { apiKey },
    });
};

export const DeleteUserModelKey = async (userId: string, modelId: string) => {
    return await prisma.userModelKey.delete({
        where: { userId_modelId: { userId, modelId } },
    });
};

// ── UserCredential ──────────────────────────────────────────────

export const CreateUserCredential = async (
    userId: string,
    provider: "GITHUB" | "VERCEL" | "CUSTOM",
    name: string,
    secret: string
) => {
    if (!userId || !provider || !name || !secret) {
        throw new Error("Missing required fields");
    }
    return await prisma.userCredential.create({
        data: { userId, provider, name, secret },
    });
};

export const UpdateUserCredential = async (
    userId: string,
    provider: "GITHUB" | "VERCEL" | "CUSTOM",
    name: string,
    secret: string
) => {
    return await prisma.userCredential.update({
        where: { userId_provider_name: { userId, provider, name } },
        data: { secret },
    });
};

export const DeleteUserCredential = async (
    userId: string,
    provider: "GITHUB" | "VERCEL" | "CUSTOM",
    name: string
) => {
    return await prisma.userCredential.delete({
        where: { userId_provider_name: { userId, provider, name } },
    });
};

// ── AIModel ─────────────────────────────────────────────────────

export const CreateAIModel = async (
    name: string,
    provider: "GEMINI" | "ANTHROPIC" | "OPENAI" | "DEEPSEEK" | "OTHER"
) => {
    return await prisma.aIModel.create({
        data: { name, provider },
    });
};

export const UpdateAIModel = async (
    id: string,
    data: {
        name?: string;
        provider?: "GEMINI" | "ANTHROPIC" | "OPENAI" | "DEEPSEEK" | "OTHER";
        isActive?: boolean;
        isSelected?: boolean;
    }
) => {
    return await prisma.aIModel.update({
        where: { id },
        data,
    });
};

export const DeleteAIModel = async (id: string) => {
    return await prisma.aIModel.delete({
        where: { id },
    });
};

// ── User (delete) ───────────────────────────────────────────────

export const DeleteUser = async (id: string) => {
    return await prisma.user.delete({
        where: { id },
    });
};