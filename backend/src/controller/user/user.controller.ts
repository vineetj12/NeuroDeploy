import { prisma } from "../../PrismaClientManager/index.ts";

export const CreateUser = async (email: string, password: string) => {
    try {
        const user = await prisma.user.create({
            data: {
                email,
                password,
            },
        });
        return user;
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
export const CheckUserAndPassword = async (email: string, password:string)=>{
    const user = await prisma.user.findUnique({
        where: { email, password },
    });
    return user;
}
